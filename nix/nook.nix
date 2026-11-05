self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.movie-night;
  roomType = lib.types.submodule {
    options = {
      id = lib.mkOption {
        type = lib.types.str;
        description = "Stable room ID.";
      };
      name = lib.mkOption {
        type = lib.types.str;
        description = "Room display name.";
      };
      path = lib.mkOption {
        type = lib.types.str;
        description = "Permanent URL path, for example /r/movie-night.";
      };
    };
  };
in
{
  options.services.movie-night = {
    enable = lib.mkEnableOption "the Nook movie-night publisher and room API";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
    environmentFile = lib.mkOption {
      type = lib.types.str;
      description = "Runtime file containing MOVIE_NIGHT_SECRET and JELLYFIN_API_KEY. Never put secrets in Nix values.";
    };
    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3100;
    };
    origin = lib.mkOption {
      type = lib.types.str;
      example = "https://watch.example.org";
    };
    relayUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://relay.example.org";
    };
    relayConnectUrl = lib.mkOption {
      type = lib.types.str;
      default = cfg.relayUrl;
      description = "Publisher dial URL; may use the private Atlas address with a matching TLS hostname.";
    };
    jellyfinUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8096";
    };
    jellyfinUserId = lib.mkOption {
      type = lib.types.str;
      description = "Jellyfin user whose complete visible video library is browsed.";
    };
    mediaRoots = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "Read-only local Jellyfin media roots.";
    };
    mediaGroup = lib.mkOption {
      type = lib.types.str;
      default = "media";
    };
    rooms = lib.mkOption {
      type = lib.types.listOf roomType;
      default = [ ];
    };
    trustedProxies = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Exact Atlas source IPs allowed to assert an SSO user.";
    };
    adminUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    internalPeers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "127.0.0.1"
        "::1"
      ];
      description = "Exact Atlas source IPs allowed to call relay authorization.";
    };
    maxActiveRooms = lib.mkOption {
      type = lib.types.ints.positive;
      default = 4;
    };
    vaapiDevice = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/dev/dri/renderD128";
    };
    openTailscaleFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Allow the API port through the tailscale0 firewall.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.mediaRoots != [ ];
        message = "Movie night requires at least one read-only media root.";
      }
    ];
    networking.firewall.interfaces.tailscale0.allowedTCPPorts =
      lib.optionals cfg.openTailscaleFirewall
        [ cfg.port ];
    systemd.services.movie-night = {
      description = "Movie night room authority and MoQ publisher";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "jellyfin.service"
      ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = cfg.mediaRoots;
      environment = {
        MOVIE_NIGHT_HOST = cfg.listenAddress;
        MOVIE_NIGHT_PORT = toString cfg.port;
        MOVIE_NIGHT_ORIGIN = cfg.origin;
        MOVIE_NIGHT_STATE = "/var/lib/movie-night";
        MOVIE_NIGHT_RELAY_URL = cfg.relayUrl;
        MOVIE_NIGHT_RELAY_CONNECT_URL = cfg.relayConnectUrl;
        MOVIE_NIGHT_MEDIA_ROOTS = lib.concatStringsSep "," cfg.mediaRoots;
        MOVIE_NIGHT_ROOMS_FILE = toString (
          pkgs.writeText "movie-night-rooms.json" (builtins.toJSON cfg.rooms)
        );
        MOVIE_NIGHT_TRUSTED_PROXIES = lib.concatStringsSep "," cfg.trustedProxies;
        MOVIE_NIGHT_ADMIN_USERS = lib.concatStringsSep "," cfg.adminUsers;
        MOVIE_NIGHT_INTERNAL_PEERS = lib.concatStringsSep "," cfg.internalPeers;
        MOVIE_NIGHT_MAX_ACTIVE_ROOMS = toString cfg.maxActiveRooms;
        JELLYFIN_URL = cfg.jellyfinUrl;
        JELLYFIN_USER_ID = cfg.jellyfinUserId;
      }
      // lib.optionalAttrs (cfg.vaapiDevice != null) { MOVIE_NIGHT_VAAPI_DEVICE = cfg.vaapiDevice; };
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = cfg.environmentFile;
        DynamicUser = true;
        SupplementaryGroups = [ cfg.mediaGroup ] ++ lib.optional (cfg.vaapiDevice != null) "render";
        StateDirectory = "movie-night";
        WorkingDirectory = "/var/lib/movie-night";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 3;
        TimeoutStopSec = 20;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        ReadOnlyPaths = cfg.mediaRoots;
        PrivateDevices = cfg.vaapiDevice == null;
        DevicePolicy = "closed";
        DeviceAllow = lib.optional (cfg.vaapiDevice != null) "${cfg.vaapiDevice} rw";
        MemoryMax = "4G";
        TasksMax = 512;
      };
    };
  };
}
