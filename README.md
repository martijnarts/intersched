# intersched

Find the first slot your whole group can make, without leaving the table. Live at <https://intersched.artsprins.nl>.

The page is in English and Dutch, picked from the phone's language. Each player taps the slots they can make in a one-week grid. A slot that someone already ruled out shows ×. When no slot is left, the next week starts. Pass one phone around, or tap Share to put everyone on their own phone. A room is four words, shown as a QR code: the words give an [iroh-gossip](https://github.com/n0-computer/iroh-gossip) topic and a record on the n0 pkarr relay where the phones in the room list themselves. It all runs in the browser. There is no server of our own.

The page is static: `index.html`, `app.js`, `strings.js`, `style.css`, `words.js` and the built `pkg/`. Cloudflare Pages serves the repository as is, with no build step.

To rebuild `pkg/` after you change `net/`:

```sh
nix develop -c ./build.sh
```

Licensed under the EUPL-1.2. The room words come from the [EFF short wordlist](https://www.eff.org/dice) (CC BY 3.0).
