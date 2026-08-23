<script lang="ts">
  /**
   * Renders text as a QR code.  The generator is loaded lazily so the ~20 KB
   * only costs anything for players who actually use the local-wifi flow —
   * Workbox still precaches the chunk, so it is there when offline.
   */
  type Props = { data: string; size?: number; label?: string };
  const { data, size = 420, label = 'QR code' }: Props = $props();

  let svg = $state('');
  let error = $state('');

  $effect(() => {
    const text = data;
    let stale = false;

    (async () => {
      try {
        const { default: qrcode } = await import('qrcode-generator');
        // Type 0 picks the smallest version that fits.  'L' rather than a
        // higher correction level on purpose: a ~740-character invite needs
        // version 19 at L against version 22 at M, which is 93 modules instead
        // of 105 — 13% larger modules at the same physical size.  These codes
        // are read off a clean phone screen, where the enemy is blur, glare and
        // moiré rather than the smudges and creases that extra error correction
        // is designed to survive, and bigger modules beat more redundancy for
        // every one of those.
        const qr = qrcode(0, 'L');
        qr.addData(text);
        qr.make();
        if (!stale) {
          svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
          error = '';
        }
      } catch (e) {
        if (!stale) error = e instanceof Error ? e.message : 'Could not draw the code.';
      }
    })();

    return () => { stale = true; };
  });
</script>

{#if error}
  <p role="alert">{error}</p>
{:else if svg}
  <!--
    White quiet zone is not decoration: scanners need the light border and a
    light background behind the modules, whatever the surrounding page does.
  -->
  <!--
    Rendered as large as the viewport allows.  Phone-to-phone scanning is
    limited by how many millimetres each module gets, so screen size is the
    single biggest lever on whether the other camera can read this at all.
  -->
  <div
    role="img"
    aria-label={label}
    style="width: min(92vw, {size}px); background: #fff; padding: 8px; display: inline-block;"
  >
    {@html svg}
  </div>
{:else}
  <p><em>Drawing code…</em></p>
{/if}
