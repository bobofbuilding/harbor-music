# Guided setup prompt

Copy the text below into an assistant on the computer that will run Harbor Music. Fill in the bracketed values if you know them.

```text
Help me set up Harbor Music on my [Mac, Linux computer, or compatible NAS]. My music folder is [path to my music folder].

Use the current README in https://github.com/bobofbuilding/harbor-music. Check that Python is available and that my media host can read the music folder. Start Harbor with ./setup-harbor and open the local owner player. Check that a sample song appears. Reuse my existing catalog if this is already set up.

Help me reach the player at a private HTTPS address using my network. Use Tailscale Serve if I already use Tailscale. Ask before changing network settings or installing software. Keep the owner controls local, and keep friend sharing disabled during setup.

Guide me through Devices and Connected devices to pair two devices. Verify they can play a song and see the same synced playlist or Favorite. Keep my music, catalog, private address, and configured Mac app out of any public files.
```
