{
  pkgs,
  moqPackage,
  src,
}:
pkgs.buildNpmPackage {
  pname = "movie-night";
  version = "0.1.0";
  inherit src;
  nodejs = pkgs.nodejs_24;
  npmDepsHash = "sha256-BmvG1OGyFdgghuChSpW//GMTUfqVOPKNjme5Xech3DU=";
  nativeBuildInputs = [ pkgs.makeWrapper ];
  doCheck = true;
  checkPhase = "npm test";
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/movie-night $out/bin
    cp -r dist src package.json $out/lib/movie-night/
    makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/movie-night \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/movie-night/src/server/main.ts" \
      --set MOVIE_NIGHT_DIST "$out/lib/movie-night/dist" \
      --prefix PATH : ${
        pkgs.lib.makeBinPath [
          pkgs.ffmpeg
          moqPackage
        ]
      }
    runHook postInstall
  '';
  meta = {
    description = "Shared Jellyfin movie nights over Media over QUIC";
    license = pkgs.lib.licenses.mit;
    mainProgram = "movie-night";
  };
}
