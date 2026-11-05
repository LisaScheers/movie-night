inputs:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.movie-night-relay;
  relayConfig = (pkgs.formats.toml { }).generate "movie-night-relay.toml" {
    listen = {
      bind = "[::]:${toString cfg.port}";
      tls = {
        cert = "/var/lib/acme/${cfg.relayDomain}/fullchain.pem";
        key = "/var/lib/acme/${cfg.relayDomain}/key.pem";
      };
    };
    web.https = {
      listen = "127.0.0.1:${toString cfg.webSocketPort}";
      cert = "/var/lib/acme/${cfg.relayDomain}/fullchain.pem";
      key = "/var/lib/acme/${cfg.relayDomain}/key.pem";
    };
    auth.url = "http://127.0.0.1:${toString cfg.authPort}/internal/relay-auth";
    internal.listen = "127.0.0.1:${toString cfg.metricsPort}";
  };
  adminProxy = ''
    auth_request /_movie-night-auth;
    auth_request_set $movie_night_user $upstream_http_x_authentik_username;
    auth_request_set $movie_night_cookie $upstream_http_set_cookie;
    add_header Set-Cookie $movie_night_cookie always;
    proxy_set_header X-Movie-Night-User $movie_night_user;
    proxy_set_header Authorization "";
  '';
in
{
  options.services.movie-night-relay = {
    enable = lib.mkEnableOption "the Atlas MoQ relay and movie-night edge";
    package = lib.mkOption {
      type = lib.types.package;
      default = inputs.moq.packages.${pkgs.stdenv.hostPlatform.system}.moq-relay;
    };
    domain = lib.mkOption {
      type = lib.types.str;
      example = "watch.example.org";
    };
    relayDomain = lib.mkOption {
      type = lib.types.str;
      example = "relay.example.org";
    };
    backendUrl = lib.mkOption {
      type = lib.types.str;
      example = "http://100.64.0.2:3100";
      description = "Nook's private API URL, reachable only over a trusted mesh network.";
    };
    authentikUrl = lib.mkOption {
      type = lib.types.str;
      example = "https://auth.example.org";
      description = "Authentik embedded proxy outpost base URL. Configure a proxy provider for domain.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 443;
      description = "UDP WebTransport port; use 443 so WebSocket fallback shares the public URL.";
    };
    webSocketPort = lib.mkOption {
      type = lib.types.port;
      default = 4444;
    };
    authPort = lib.mkOption {
      type = lib.types.port;
      default = 9191;
    };
    metricsPort = lib.mkOption {
      type = lib.types.port;
      default = 9192;
    };
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
    };
  };
  config = lib.mkIf cfg.enable {
    users.groups.movie-night-relay = { };
    users.users.movie-night-relay = {
      isSystemUser = true;
      group = "movie-night-relay";
    };
    users.users.nginx.extraGroups = [ "movie-night-relay" ];
    security.acme.certs.${cfg.relayDomain} = {
      group = "movie-night-relay";
    };
    services.nginx.enable = true;
    services.nginx.virtualHosts = {
      ${cfg.domain} = {
        forceSSL = true;
        enableACME = true;
        extraConfig = "access_log off;";
        locations = {
          "/" = {
            proxyPass = cfg.backendUrl;
            extraConfig = ''
              proxy_set_header X-Movie-Night-User "";
              proxy_set_header Authorization "";
              proxy_set_header Cookie "";
              proxy_buffering off;
              proxy_read_timeout 1h;
            '';
          };
          "/internal/".extraConfig = "return 404;";
          "/api/admin/" = {
            proxyPass = cfg.backendUrl;
            extraConfig = adminProxy;
          };
          "= /api/room/command" = {
            proxyPass = cfg.backendUrl;
            extraConfig = adminProxy + ''
              error_page 401 403 = @movie-night-guest-command;
            '';
          };
          "@movie-night-guest-command" = {
            proxyPass = cfg.backendUrl;
            extraConfig = ''
              proxy_set_header X-Movie-Night-User "";
              proxy_set_header Authorization "";
              proxy_set_header Cookie "";
            '';
          };
          "= /_movie-night-auth" = {
            proxyPass = "${cfg.authentikUrl}/outpost.goauthentik.io/auth/nginx";
            recommendedProxySettings = false;
            extraConfig = ''
              internal;
              proxy_pass_request_body off;
              proxy_set_header Content-Length "";
              proxy_set_header Host $proxy_host;
              proxy_set_header X-Forwarded-Host ${cfg.domain};
              proxy_set_header X-Forwarded-Proto https;
              proxy_set_header X-Original-URL https://${cfg.domain}$request_uri;
              proxy_ssl_server_name on;
              proxy_ssl_verify on;
              proxy_ssl_verify_depth 3;
              proxy_ssl_trusted_certificate ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt;
            '';
          };
          "/outpost.goauthentik.io/" = {
            proxyPass = "${cfg.authentikUrl}/outpost.goauthentik.io/";
            extraConfig = ''
              proxy_set_header Host $proxy_host;
              proxy_set_header X-Forwarded-Host ${cfg.domain};
              proxy_set_header X-Forwarded-Proto https;
              proxy_ssl_server_name on;
              proxy_ssl_verify on;
              proxy_ssl_verify_depth 3;
              proxy_ssl_trusted_certificate ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt;
            '';
          };
        };
      };
      ${cfg.relayDomain} = {
        forceSSL = true;
        enableACME = true;
        extraConfig = "access_log off;";
        locations."/" = {
          proxyPass = "https://127.0.0.1:${toString cfg.webSocketPort}";
          proxyWebsockets = true;
          extraConfig = ''
            proxy_ssl_server_name on;
            proxy_ssl_name ${cfg.relayDomain};
            proxy_ssl_verify on;
            proxy_ssl_verify_depth 3;
            proxy_ssl_trusted_certificate ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt;
            proxy_read_timeout 1h;
          '';
        };
      };
      "movie-night-internal" = {
        listen = [
          {
            addr = "127.0.0.1";
            port = cfg.authPort;
          }
        ];
        extraConfig = "access_log off;";
        locations."= /internal/relay-auth" = {
          proxyPass = "${cfg.backendUrl}/internal/relay-auth";
        };
        locations."/".extraConfig = "return 404;";
      };
    };
    networking.firewall.allowedUDPPorts = lib.optionals cfg.openFirewall [ cfg.port ];
    networking.firewall.allowedTCPPorts = lib.optionals cfg.openFirewall [
      80
      443
    ];
    boot.kernel.sysctl = {
      "net.core.rmem_max" = lib.mkDefault 8388608;
      "net.core.wmem_max" = lib.mkDefault 8388608;
    };
    systemd.services.movie-night-relay = {
      description = "Atlas movie-night MoQ relay";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "nginx.service"
        "acme-finished-${cfg.relayDomain}.target"
      ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} ${relayConfig}";
        User = "movie-night-relay";
        Group = "movie-night-relay";
        Restart = "on-failure";
        RestartSec = 3;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        LimitNOFILE = 65536;
        AmbientCapabilities = lib.optional (cfg.port < 1024) "CAP_NET_BIND_SERVICE";
        CapabilityBoundingSet = lib.optional (cfg.port < 1024) "CAP_NET_BIND_SERVICE";
      };
    };
  };
}
