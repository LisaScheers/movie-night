{ pkgs, inputs, ... }:
{
  packages = [
    pkgs.nodejs_24
    pkgs.ffmpeg
    pkgs.openssl
    pkgs.nixfmt
    inputs.moq.packages.${pkgs.stdenv.hostPlatform.system}.moq
    inputs.moq.packages.${pkgs.stdenv.hostPlatform.system}.moq-relay
  ];
  devenv.flakesIntegration = true;
  # Use the locked flake output, avoiding an import-from-derivation during cross-system shell evaluation.
  task.package = inputs.devenv.packages.${pkgs.stdenv.hostPlatform.system}.devenv-tasks;
  env.SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  processes = {
    app.exec = "npm run server";
    web.exec = "npm run dev";
    relay.exec = "moq-relay examples/relay.dev.toml";
  };
  scripts.check.exec = "npm run build && npm test";
  scripts.setup.exec = ''
    npm ci
    if [ ! -f .env ]; then
      cp .env.example .env
      chmod 600 .env
      secret=$(openssl rand -hex 32)
      admin_token=$(openssl rand -hex 32)
      ${pkgs.python3}/bin/python3 - "$secret" "$admin_token" <<'PY'
    import pathlib, sys
    file = pathlib.Path('.env')
    file.write_text(file.read_text().replace('generate-a-secret-with-devenv-setup', sys.argv[1]).replace('generate-an-admin-token-with-devenv-setup', sys.argv[2]))
    PY
    fi
  '';
  enterShell = ''echo "Movie night: setup once, edit .env, then devenv up. Run check for build + tests."'';
}
