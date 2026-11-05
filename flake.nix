{
  description = "Movie night — shared Jellyfin screenings over MoQ";
  inputs = {
    moq.url = "github:moq-dev/moq/moq-relay-v0.17.12";
    nixpkgs.follows = "moq/nixpkgs";
    devenv = {
      url = "github:cachix/devenv";
    };
    devenv-root = {
      url = "file+file:///dev/null";
      flake = false;
    };
  };
  nixConfig = {
    extra-substituters = [ "https://kixelated.cachix.org" ];
    extra-trusted-public-keys = [
      "kixelated.cachix.org-1:CmFcV0lyM6KuVM2m9mih0q4SrAa0XyCsiM7GHrz3KKk="
    ];
  };
  outputs =
    inputs@{
      self,
      nixpkgs,
      devenv,
      moq,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      packageFor =
        system:
        import ./nix/package.nix {
          pkgs = nixpkgs.legacyPackages.${system};
          moqPackage = moq.packages.${system}.moq;
          src = self;
        };
    in
    {
      packages = eachSystem (system: {
        default = packageFor system;
        movie-night = packageFor system;
      });
      devShells = eachSystem (system: {
        default = devenv.lib.mkShell {
          inherit inputs;
          pkgs = nixpkgs.legacyPackages.${system};
          modules = [
            ./devenv.nix
            ({ lib, ... }: {
              devenv.root = lib.mkOverride 90 (
                let
                  root = builtins.readFile inputs.devenv-root;
                in
                if root != "" then
                  root
                else if builtins.getEnv "PWD" != "" then
                  builtins.getEnv "PWD"
                else
                  toString self
              );
            })
          ];
        };
      });
      checks = eachSystem (system: {
        app = self.packages.${system}.default;
        modules = import ./nix/module-check.nix { inherit self inputs system; };
      });
      nixosModules = {
        nook = import ./nix/nook.nix self;
        atlas = import ./nix/atlas.nix inputs;
        authentik = import ./nix/authentik.nix;
      };
      formatter = eachSystem (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
