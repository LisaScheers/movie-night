import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Room } from '../shared.ts';
import type { Config } from './config.ts';
import { allowedFile, type Source } from './library.ts';
import { streamUrl } from './auth.ts';

export interface Running { stop(): Promise<void>; }
export interface Publisher {
  start(room: Room, source: Source, ready: (position: number) => void, ended: (error: string | null) => void): Promise<Running>;
}
function filterQuote(value: string): string {
  // libavfilter parses once for the graph and once for the option value.
  return value.replace(/[\\':,;\[\]]/g, '\\$&').replace(/[\\':,;\[\]]/g, '\\$&');
}
export async function ffmpegArgs(config: Config, room: Room, source: Source): Promise<string[]> {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-re', '-ss', String(room.position), '-i', source.path];
  const subtitle = source.streams.find(s => s.Type === 'Subtitle' && s.Index === room.subtitle);
  let videoFilter = "scale=w='min(1920,iw)':h=-2:force_original_aspect_ratio=decrease,format=yuv420p";
  if (subtitle) {
    if (['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(subtitle.Codec ?? '')) {
      if (subtitle.IsExternal) throw new Error('External bitmap subtitles are not supported');
      args.push('-filter_complex', `[0:v:0][0:${subtitle.Index}]overlay,${videoFilter}[video]`, '-map', '[video]');
      videoFilter = '';
    } else {
      const subtitlePath = subtitle.IsExternal && subtitle.Path ? await allowedFile(subtitle.Path, config.mediaRoots) : source.path;
      const index = subtitle.IsExternal ? 0 : source.streams.filter(s => s.Type === 'Subtitle').findIndex(s => s.Index === subtitle.Index);
      // The subtitles demuxer keeps original timestamps after input seeking.
      videoFilter = `setpts=PTS+${room.position}/TB,subtitles=filename=${filterQuote(subtitlePath)}:si=${index},setpts=PTS-STARTPTS,${videoFilter}`;
    }
  }
  if (videoFilter) args.push('-map', '0:v:0', '-vf', videoFilter + (config.vaapi ? ',format=nv12,hwupload' : ''));
  else if (config.vaapi) throw new Error('Bitmap subtitles require software encoding; unset MOVIE_NIGHT_VAAPI_DEVICE');
  args.push('-map', room.audio === null ? '0:a:0?' : `0:${room.audio}`, '-sn', '-dn');
  if (config.vaapi) args.unshift('-vaapi_device', config.vaapi);
  args.push('-c:v', config.vaapi ? 'h264_vaapi' : 'libx264');
  if (!config.vaapi) args.push('-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high');
  args.push('-b:v', '5000k', '-maxrate', '6000k', '-bufsize', '10000k', '-r', '30', '-g', '30', '-bf', '0',
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '160k', '-progress', 'pipe:3',
    '-f', 'mpegts', '-pes_payload_size', '0', '-muxdelay', '0', 'pipe:1');
  return args;
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([closed, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.race([closed, delay(1500)]);
}
export class FFmpegPublisher implements Publisher {
  readonly config: Config;
  constructor(config: Config) { this.config = config; }
  async start(room: Room, source: Source, ready: (position: number) => void, ended: (error: string | null) => void): Promise<Running> {
    const args = await ffmpegArgs(this.config, room, source);
    const moq = spawn(this.config.moq, ['--connect', streamUrl(this.config.relayConnectUrl, this.config.secret, room, 'publisher'),
      '--broadcast', `${room.generation}.hang`, 'import', 'ts'], { stdio: ['pipe', 'ignore', 'pipe'] });
    const ffmpeg = spawn(this.config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stopped = false, finished = false, prepared = false, progress = '';
    const stop = async () => { stopped = true; clearTimeout(timeout); await Promise.all([terminate(ffmpeg), terminate(moq)]); };
    const finish = (error: string | null) => {
      if (stopped || finished) return;
      finished = true; clearTimeout(timeout);
      void stop().then(() => ended(error));
    };
    const timeout = setTimeout(() => finish('The publisher did not start within 30 seconds'), 30_000);
    const journal = (data: Buffer) => {
      // CLI diagnostics can contain a dial URL. Never write its credential.
      process.stderr.write(data.toString().replace(/jwt=[^\s"']+/g, 'jwt=[redacted]'));
    };
    ffmpeg.stderr?.on('data', journal); moq.stderr?.on('data', journal);
    ffmpeg.stdout?.pipe(moq.stdin!);
    moq.stdin?.on('error', () => finish('The relay connection closed'));
    ffmpeg.on('error', () => finish('Could not start FFmpeg'));
    moq.on('error', () => finish('Could not start the MoQ publisher'));
    const progressPipe = ffmpeg.stdio[3];
    if (progressPipe && 'on' in progressPipe) progressPipe.on('data', (data: Buffer) => {
      progress += data.toString();
      const lines = progress.split('\n'); progress = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (!prepared && match && Number(match[1]) > 0) {
          prepared = true; clearTimeout(timeout);
          ready(room.position + Math.max(0, Number(match[1]) / 1_000_000 - 0.35));
        }
      }
    });
    ffmpeg.on('close', code => {
      if (code === 0) setTimeout(() => finish(null), 800).unref();
      else finish('The encoder stopped unexpectedly; check the service journal');
    });
    moq.on('close', code => {
      if (code !== 0) finish('The MoQ publisher stopped unexpectedly; check the service journal');
    });
    return { stop };
  }
}
