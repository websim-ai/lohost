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
        isAarch64 = pkgs.stdenv.isAarch64;

        platform =
          if isDarwin then
            if isAarch64 then "darwin-arm64" else "darwin-x64"
          else
            if isAarch64 then "linux-arm64" else "linux-x64";

        libExt = if isDarwin then "dylib" else "so";
        libName = "liblohost_dns.${libExt}";

        version = "0.0.1";

        # Native DNS interposition library (build from source - fast C compile)
        lohost-dns = pkgs.stdenv.mkDerivation {
          pname = "lohost-dns";
          inherit version;
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

        # Pre-built binary URLs (populated after first release)
        # To get sha256: nix-prefetch-url <url>
        binaryUrls = {
          "darwin-arm64" = {
            url = "https://github.com/websim-ai/lohost/releases/download/v${version}/lohost-darwin-arm64";
            sha256 = "0000000000000000000000000000000000000000000000000000"; # placeholder
          };
          "darwin-x64" = {
            url = "https://github.com/websim-ai/lohost/releases/download/v${version}/lohost-darwin-x64";
            sha256 = "0000000000000000000000000000000000000000000000000000"; # placeholder
          };
          "linux-x64" = {
            url = "https://github.com/websim-ai/lohost/releases/download/v${version}/lohost-linux-x64";
            sha256 = "0000000000000000000000000000000000000000000000000000"; # placeholder
          };
          "linux-arm64" = {
            url = "https://github.com/websim-ai/lohost/releases/download/v${version}/lohost-linux-arm64";
            sha256 = "0000000000000000000000000000000000000000000000000000"; # placeholder
          };
        };

        # lohost binary package (fetches pre-built binary + wraps with native lib)
        lohost = pkgs.stdenv.mkDerivation {
          pname = "lohost";
          inherit version;

          src = pkgs.fetchurl {
            inherit (binaryUrls.${platform}) url sha256;
          };

          dontUnpack = true;

          installPhase = ''
            mkdir -p $out/bin

            # Install the binary
            cp $src $out/bin/.lohost-unwrapped
            chmod +x $out/bin/.lohost-unwrapped

            # Create wrapper that sets native lib path
            cat > $out/bin/lohost <<EOF
#!/bin/sh
export LOHOST_NATIVE_LIB="${lohost-dns}/lib/${libName}"
exec $out/bin/.lohost-unwrapped "\$@"
EOF
            chmod +x $out/bin/lohost
          '';

          meta = {
            description = "Local virtual host router for development";
            homepage = "https://github.com/websim-ai/lohost";
            license = pkgs.lib.licenses.mit;
            platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
          };
        };

        # For development: build lohost from source using bun
        lohost-dev = pkgs.stdenv.mkDerivation {
          pname = "lohost-dev";
          inherit version;
          src = ./.;

          nativeBuildInputs = [ pkgs.bun ];

          buildPhase = ''
            export HOME=$TMPDIR
            bun build --compile --outfile lohost-bin src/index.ts
          '';

          installPhase = ''
            mkdir -p $out/bin

            cp lohost-bin $out/bin/.lohost-unwrapped
            chmod +x $out/bin/.lohost-unwrapped

            cat > $out/bin/lohost <<EOF
#!/bin/sh
export LOHOST_NATIVE_LIB="${lohost-dns}/lib/${libName}"
exec $out/bin/.lohost-unwrapped "\$@"
EOF
            chmod +x $out/bin/lohost
          '';
        };

      in {
        packages = {
          inherit lohost lohost-dns lohost-dev;
          default = lohost-dev;  # Use dev build until first release with binaries
        };

        # Dev shell with native lib available
        devShells.default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.bun
            pkgs.just
          ];

          shellHook = ''
            echo "lohost dev shell"
            echo "Run 'bun run build:bin' to build standalone binary"
          '';
        };
      });
}
