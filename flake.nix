{
  description = "lohost - Local virtual host router for development";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Platform detection
        isDarwin = pkgs.stdenv.isDarwin;
        libExt = if isDarwin then "dylib" else "so";
        libName = "liblohost_dns.${libExt}";

        # Native DNS interposition library
        lohost-dns = pkgs.stdenv.mkDerivation {
          pname = "lohost-dns";
          version = "0.0.1";
          src = ./native;

          buildPhase = if isDarwin then ''
            $CC -dynamiclib -o ${libName} darwin/lohost_dns.c
          '' else ''
            $CC -shared -fPIC -o ${libName} linux/lohost_dns.c -ldl
          '';

          installPhase = ''
            mkdir -p $out/lib
            cp ${libName} $out/lib/
          '';
        };

        # Full lohost package (native lib + compiled TypeScript)
        lohost = pkgs.stdenv.mkDerivation {
          pname = "lohost";
          version = "0.0.1";
          src = ./.;

          nativeBuildInputs = [ pkgs.nodejs_22 ];

          buildPhase = ''
            export HOME=$TMPDIR
            export npm_config_cache=$TMPDIR/.npm
            npm ci --ignore-scripts
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/lib/lohost $out/bin

            # Copy compiled JS and package.json
            cp -r dist $out/lib/lohost/
            cp package.json $out/lib/lohost/

            # Create wrapper script
            cat > $out/bin/lohost <<EOF
            #!${pkgs.bash}/bin/bash
            export LOHOST_NATIVE_LIB="${lohost-dns}/lib/${libName}"
            exec ${pkgs.nodejs_22}/bin/node $out/lib/lohost/dist/index.js "\$@"
            EOF
            chmod +x $out/bin/lohost
          '';
        };

      in {
        packages = {
          inherit lohost lohost-dns;
          default = lohost;
        };

        # For use in other flakes - just the native library
        lib = {
          nativeLibPath = "${lohost-dns}/lib/${libName}";
        };

        # Dev shell with native lib available
        devShells.default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.just
          ];

          LOHOST_NATIVE_LIB = "${lohost-dns}/lib/${libName}";

          shellHook = ''
            echo "lohost dev shell"
            echo "Native lib: $LOHOST_NATIVE_LIB"
          '';
        };
      });
}
