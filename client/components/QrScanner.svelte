<script lang="ts">
  /**
   * Camera QR scanner.
   *
   * Uses jsQR rather than the native BarcodeDetector because the devices this
   * feature exists for include iPhones, and Safari has no BarcodeDetector — a
   * fallback would be needed anyway, so there is only the fallback.
   *
   * Mounted in response to a button press, which matters on iOS: getUserMedia
   * needs a user gesture, and the video element needs `playsinline` and `muted`
   * or Safari refuses to play it inline.
   */
  import { onDestroy } from 'svelte';

  type Props = { onscan: (text: string) => void; oncancel?: () => void };
  const { onscan, oncancel }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);
  let status = $state('Starting camera…');
  let error = $state('');

  let stream: MediaStream | null = null;
  let frame: number | null = null;
  let done = false;

  function stop() {
    done = true;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }

  onDestroy(stop);

  $effect(() => {
    const el = video;
    if (!el || done) return;

    (async () => {
      let decode: typeof import('jsqr').default;
      try {
        decode = (await import('jsqr')).default;
      } catch {
        error = 'Could not load the QR reader.';
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        error = name === 'NotAllowedError'
          ? 'Camera access was refused. The camera is the only way to read the other device’s code — allow it and try again.'
          : 'No camera available on this device.';
        return;
      }

      el.srcObject = stream;
      el.setAttribute('playsinline', 'true');
      try { await el.play(); } catch { /* autoplay can reject; the loop copes */ }
      status = 'Point the camera at the other device’s code.';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { error = 'Could not read from the camera.'; return; }

      const tick = () => {
        if (done) return;
        if (el.readyState === el.HAVE_ENOUGH_DATA && el.videoWidth > 0) {
          canvas.width = el.videoWidth;
          canvas.height = el.videoHeight;
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = decode(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert',
          });
          if (found?.data) {
            stop();
            onscan(found.data);
            return;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    })();
  });
</script>

{#if error}
  <p role="alert">{error}</p>
  {#if oncancel}
    <button type="button" onclick={() => { stop(); oncancel(); }}>Back</button>
  {/if}
{:else}
  <p aria-live="polite">{status}</p>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={video}
    autoplay
    muted
    playsinline
    style="width: 320px; max-width: 100%; background: #000;"
  ></video>
  <br />
  {#if oncancel}
    <button type="button" onclick={() => { stop(); oncancel(); }}>Cancel</button>
  {/if}
{/if}
