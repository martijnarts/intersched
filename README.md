# intersched

Find the first slot your whole group can make, without leaving the table. Live at <https://intersched.artsprins.nl>.

Each player taps the slots they can make in a one-week grid. A slot that someone already ruled out shows ×. When no slot is left, the next week starts. Pass one phone around, or put everyone on their own phone: the invite QR code joins an [iroh-gossip](https://github.com/n0-computer/iroh-gossip) room that runs in the browser over iroh relays. There is no server of our own.

The page is static: `index.html`, `app.js`, `style.css` and the built `pkg/`. Cloudflare Pages serves the repository as is, with no build step.

To rebuild `pkg/` after you change `net/`:

```sh
nix develop -c ./build.sh
```

Licensed under the EUPL-1.2.
