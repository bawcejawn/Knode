# Old guest keys on bawcejawn.github.io (audit BX-39)

Until 28 October 2026 Knode Games ran on `bawcejawn.github.io/Knode/`. A guest wallet made there is stored in that
browser for the whole `bawcejawn.github.io` address, which every GitHub Pages site of the account shares
(SwarmTales, Mana Station, …). GitHub now sends old Knode links straight to knodegames.com, so no Knode page runs at
the old address any more: those keys can only be moved or erased by a page that runs **at** `bawcejawn.github.io`.

`guest-move.html` is that page. It loads nothing and sends nothing. It finds an old guest key in the browser, shows
it only when the player asks (to paste into **Restore a guest key** on knodegames.com), and erases it from the old
address once the player ticks that it works.

## Where it goes (decided 2026-10-29)

Its own small public repository, **`bawcejawn/knode-guest-move`**, with only this page (as `index.html`) and GitHub
Pages switched on. Then the link is `https://bawcejawn.github.io/knode-guest-move/`.

Why its own repository: it keeps a Knode file out of SwarmTales and Mana Station, nothing else runs next to it, and it
can simply be deleted once nobody needs it (plan: about 30 days after the move, end of November 2026).

1. On github.com: **New repository**, name `knode-guest-move`, **Public**, tick "Add a README", **Create**.
2. Tell Claude "guest-move repo made": Claude pushes `index.html` (this page) to it.
3. In the repository: **Settings → Pages → Branch: main, folder: / (root) → Save**. After a minute or two the link works.
4. Tell players who used a guest wallet before 28 October to open the link once, in the same browser they played in.

The page runs only at `https://bawcejawn.github.io` (audit BX-66) and never loads anything else; if you edit it, keep the
`Content-Security-Policy` line.
