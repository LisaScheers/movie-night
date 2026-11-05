{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.movie-night-authentik;
  blueprint = pkgs.writeText "movie-night-authentik.yaml" ''
    version: 1
    metadata:
      name: Movie night administrators
    entries:
      - model: authentik_providers_proxy.proxyprovider
        identifiers:
          name: Movie night admin
        id: provider
        attrs:
          authorization_flow: !Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]
          invalidation_flow: !Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]
          external_host: ${builtins.toJSON "https://${cfg.domain}"}
          mode: forward_single
          intercept_header_auth: false
          access_token_validity: minutes=5
      - model: authentik_core.application
        identifiers:
          slug: movie-night
        id: application
        attrs:
          name: Movie night
          provider: !KeyOf provider
          meta_launch_url: ${builtins.toJSON "https://${cfg.domain}/admin"}
          policy_engine_mode: all
      - model: authentik_policies_expression.expressionpolicy
        identifiers:
          name: Movie night administrators
        id: administrators
        attrs:
          expression: ${builtins.toJSON "return request.user.username in ${builtins.toJSON cfg.adminUsers}"}
      - model: authentik_policies.policybinding
        identifiers:
          target: !KeyOf application
          order: 0
        attrs:
          policy: !KeyOf administrators
  '';
in
{
  options.services.movie-night-authentik = {
    enable = lib.mkEnableOption "declarative Authentik admin authentication for movie night";
    domain = lib.mkOption {
      type = lib.types.str;
      example = "watch.example.org";
    };
    adminUsers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "The same usernames as services.movie-night.adminUsers on Nook.";
    };
    environmentFile = lib.mkOption {
      type = lib.types.str;
      description = "Existing Authentik runtime environment file.";
    };
    manageCommand = lib.mkOption {
      type = lib.types.str;
      description = "Path to the host Authentik manage.py executable.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.adminUsers != [ ];
        message = "Movie night requires at least one Authentik administrator.";
      }
    ];
    systemd.services.authentik-movie-night-blueprint = {
      description = "Apply movie-night Authentik provider and admin policy";
      requiredBy = [ "authentik.service" ];
      before = [ "authentik.service" ];
      after = [ "authentik-migrate.service" ];
      requires = [ "authentik-migrate.service" ];
      restartTriggers = [ blueprint ];
      serviceConfig = {
        Type = "oneshot";
        DynamicUser = true;
        User = "authentik";
        StateDirectory = "authentik";
        WorkingDirectory = "%S/authentik";
        EnvironmentFile = [ cfg.environmentFile ];
        Environment = [ "AUTHENTIK_CONFIG=/etc/authentik/config.yml" ];
        ExecStartPre = "${pkgs.coreutils}/bin/install -D -m 0600 ${blueprint} %S/authentik/blueprints/movie-night.yaml";
        ExecStart = "${cfg.manageCommand} apply_blueprint movie-night.yaml";
        ExecStartPost = ''${cfg.manageCommand} shell -c "from authentik.outposts.models import Outpost; from authentik.providers.proxy.models import ProxyProvider; outpost = Outpost.objects.get(managed='goauthentik.io/outposts/embedded'); outpost.providers.add(ProxyProvider.objects.get(name='Movie night admin')); outpost.save()"'';
      };
    };
  };
}
