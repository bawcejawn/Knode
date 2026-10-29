# Old guest keys on bawcejawn.github.io (audit BX-39)

Until 28 October 2026 Knode Games ran on `bawcejawn.github.io/Knode/`. A guest wallet made there is stored in that
browser for the whole `bawcejawn.github.io` address, which every GitHub Pages site of the account shares
(SwarmTales, Mana Station, …). GitHub now sends old Knode links straight to knodegames.com, so no Knode page runs at
the old address any more: those keys can only be moved or erased by a page that runs **at** `bawcejawn.github.io`.

`guest-move.html` is that page. It loads nothing and sends nothing. It finds an old guest key in the browser, shows
it only when the player asks (to paste into **Restore a guest key** on knodegames.com), and erases it from the old
address once the player ticks that it works.

## Put it online (owner)

Put the file in any of your repositories that GitHub Pages serves at `bawcejawn.github.io` (for example SwarmTales),
in the folder Pages serves, commit and push. It is then at `https://bawcejawn.github.io/<repo>/guest-move.html`.
Tell players who used a guest wallet before 28 October to open that link once, in the same browser they played in.

The page should never load anything else; if you edit it, keep the `Content-Security-Policy` line.
