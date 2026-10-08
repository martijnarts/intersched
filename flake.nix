{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, fenix, ... }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system} fenix.packages.${system});
    in
    {
      devShells = forAll (pkgs: fx: {
        default = pkgs.mkShell {
          packages = [
            (fx.combine [
              fx.stable.cargo
              fx.stable.rustc
              fx.targets.wasm32-unknown-unknown.stable.rust-std
            ])
            # Must match the wasm-bindgen version pinned in net/Cargo.toml.
            pkgs.wasm-bindgen-cli_0_2_127
            pkgs.binaryen
            pkgs.llvmPackages.clang-unwrapped
            pkgs.llvmPackages.bintools-unwrapped
          ];
          # ring compiles C for wasm32 and needs a clang that targets it.
          CC_wasm32_unknown_unknown = "clang";
          AR_wasm32_unknown_unknown = "llvm-ar";
        };
      });
    };
}
