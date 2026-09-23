# SPDX-License-Identifier: MIT
# Copyright (c) 2026 NEURAFLOK contributors
{
  description = "NEURAFLOK development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      package = builtins.fromJSON (builtins.readFile ./package.json);

      versionMajor = value:
        let
          match = builtins.match "[^0-9]*([0-9]+).*" value;
        in
        if match == null then
          throw "Could not read a major version from ${value}"
        else
          builtins.elemAt match 0;

      electronAttr = "electron_${versionMajor package.devDependencies.electron}";
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      developmentFor =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          electron =
            if builtins.hasAttr electronAttr pkgs then
              pkgs.${electronAttr}
            else
              throw "nixpkgs does not provide ${electronAttr}, required by package.json";
          # Match CI because @types/node follows Electron's embedded Node version.
          nodejs = pkgs.nodejs_22;

          nodeModules = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./.;
            inherit nodejs;
            derivationArgs = {
              # Disable Electron downloads and link to nixpkgs Electron for offline, reproducible builds.
              npmRebuildFlags = [ "--ignore-scripts" ];

              nativeBuildInputs = [ pkgs.pkg-config ];
              buildInputs = [ pkgs.vips ];
              env.SHARP_FORCE_GLOBAL_LIBVIPS = "1";

              preInstall = ''
                export PATH="$PWD/node_modules/.bin:$PATH"

                # Point npm and electron-vite to the same nixpkgs Electron runtime.
                printf '%s' electron > node_modules/electron/path.txt
                rm -rf node_modules/electron/dist
                ln -s ${electron.dist} node_modules/electron/dist

                # Build sharp against nixpkgs libvips because npm lifecycle scripts are disabled.
                pushd node_modules/sharp >/dev/null
                node install/build.js
                popd >/dev/null
              '';
            };
          };
        in
        {
          inherit pkgs electron nodejs nodeModules;
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          development = developmentFor system;
          inherit (development) pkgs electron nodejs nodeModules;
          inherit (pkgs) lib;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.importNpmLock.hooks.linkNodeModulesHook
              nodejs
              nodejs.passthru.python
              electron
              pkgs.git
              pkgs.gnutar
              pkgs.pkg-config
              pkgs.vips
              pkgs.ripgrep
              pkgs.unzip
            ];

            npmDeps = nodeModules;
            ELECTRON_OVERRIDE_DIST_PATH = "${electron.dist}";
            SHARP_FORCE_GLOBAL_LIBVIPS = "1";
            LD_LIBRARY_PATH = lib.makeLibraryPath [
              pkgs.stdenv.cc.cc.lib
              pkgs.vips
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          inherit (developmentFor system) pkgs nodejs nodeModules;
        in
        {
          node-modules = nodeModules;
          native-runtime = pkgs.runCommand "neuraflok-native-runtime" {
            nativeBuildInputs = [ nodejs ];
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.vips ];
          } ''
            cd ${nodeModules}
            node - <<'JS'
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const sharp = require('sharp');
            assert.equal(typeof require('node-pty').spawn, 'function');
            assert.ok(fs.existsSync(require('electron')));
            sharp({ create: { width: 1, height: 1, channels: 4, background: '#000' } })
              .png().toBuffer().then(bytes => assert.ok(bytes.length > 0));
            JS
            touch $out
          '';
        }
      );
    };
}
