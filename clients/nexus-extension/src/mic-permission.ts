/** The one-time microphone grant. An offscreen document cannot show a permission prompt, so the
 *  grant is taken here, in a real tab, against the extension's own origin — after which the
 *  offscreen capture can open the microphone silently for every later call. */
const button = document.getElementById('grant') as HTMLButtonElement;
const done = document.getElementById('done') as HTMLParagraphElement;

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // The grant is what we came for; releasing the device immediately is the polite part.
    for (const track of stream.getTracks()) track.stop();
    done.textContent = 'Allowed. You can close this tab and start your call.';
    done.style.color = '#4ade80';
    chrome.runtime.sendMessage({ type: 'mic-granted' }).catch(() => { /* worker asleep */ });
  } catch (err) {
    done.textContent = `Chrome refused: ${(err as Error).name}. Open the site settings for this extension and allow the microphone.`;
    done.style.color = '#ff6b6b';
    button.disabled = false;
  }
});
