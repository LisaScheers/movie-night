{
  self,
  inputs,
  system,
}:
let
  pkgs = inputs.nixpkgs.legacyPackages.${system};
  eval = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      self.nixosModules.nook
      self.nixosModules.atlas
      self.nixosModules.authentik
      ({ pkgs, ... }: {
        system.stateVersion = "26.05";
        boot.isContainer = true;
        fileSystems."/" = {
          device = "none";
          fsType = "tmpfs";
        };
        services.movie-night = {
          enable = true;
          package = pkgs.hello;
          environmentFile = "/run/secrets/movie-night";
          origin = "https://watch.example.org";
          relayUrl = "https://relay.example.org";
          jellyfinUserId = "abc123";
          mediaRoots = [ "/srv/media" ];
        };
        services.movie-night-relay = {
          enable = true;
          package = pkgs.hello;
          domain = "watch.example.org";
          relayDomain = "relay.example.org";
          backendUrl = "http://100.64.0.2:3100";
          authentikUrl = "https://auth.example.org";
        };
        services.movie-night-authentik = {
          enable = true;
          domain = "watch.example.org";
          adminUsers = [ "host" ];
          environmentFile = "/run/secrets/authentik";
          manageCommand = "${pkgs.hello}/bin/hello";
        };
        security.acme = {
          acceptTerms = true;
          defaults.email = "admin@example.org";
        };
      })
    ];
  };
  cfg = eval.config;
  valid =
    builtins.all (entry: entry.assertion) cfg.assertions
    && cfg.systemd.services.movie-night.serviceConfig.DynamicUser
    &&
      cfg.services.nginx.virtualHosts."watch.example.org".locations."/internal/".extraConfig
      == "return 404;"
    && cfg.networking.firewall.allowedUDPPorts == [ 443 ]
    && cfg.systemd.services.movie-night-relay.serviceConfig.ProtectSystem == "strict";
in
assert valid;
pkgs.runCommand "movie-night-module-check" { } "touch $out"
