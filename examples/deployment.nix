# In your host flake, add movie-night.url = "github:LisaScheers/movie-night".
# Apply these fragments to the respective machines; keep credentials out of Git.
{ inputs, ... }:
{
  # Atlas
  atlas = { config, ... }: {
    imports = [
      inputs.movie-night.nixosModules.atlas
      inputs.movie-night.nixosModules.authentik
    ];
    services.movie-night-relay = {
      enable = true;
      domain = "watch.example.org";
      relayDomain = "relay.example.org";
      backendUrl = "http://100.64.0.2:3100";
      authentikUrl = "https://auth.example.org";
    };
    services.movie-night-authentik = {
      enable = true;
      domain = "watch.example.org";
      adminUsers = [ "host" ];
      environmentFile = "/run/agenix/authentik-env";
      manageCommand = "${config.services.authentik.authentikComponents.manage}/bin/manage.py";
    };
  };
  # Nook
  nook = {
    imports = [ inputs.movie-night.nixosModules.nook ];
    services.movie-night = {
      enable = true;
      environmentFile = "/run/agenix/movie-night-env";
      listenAddress = "100.64.0.2";
      origin = "https://watch.example.org";
      relayUrl = "https://relay.example.org";
      jellyfinUserId = "replace-with-jellyfin-user-id";
      mediaRoots = [ "/srv/media/library" ];
      trustedProxies = [ "100.64.0.1" ];
      internalPeers = [ "100.64.0.1" ];
      adminUsers = [ "host" ];
      openTailscaleFirewall = true;
      # vaapiDevice = "/dev/dri/renderD128";
      rooms = [
        {
          id = "movie-night";
          name = "Movie night";
          path = "/r/movie-night";
        }
        {
          id = "series-night";
          name = "Series night";
          path = "/series";
        }
      ];
    };
  };
}
