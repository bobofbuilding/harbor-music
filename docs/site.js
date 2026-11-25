const copyStatus = document.querySelector('#copy-status');

if (navigator.clipboard?.writeText) {
  for (const button of document.querySelectorAll('[data-copy]')) {
    const command = document.getElementById(button.dataset.copy);
    const label = button.textContent;
    let resetLabel;

    button.hidden = false;
    button.addEventListener('click', async () => {
      clearTimeout(resetLabel);
      copyStatus.textContent = '';
      try {
        await navigator.clipboard.writeText(command.textContent);
        button.textContent = 'Copied';
        copyStatus.textContent = 'Copied to the clipboard.';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(command);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Copy manually';
        copyStatus.textContent = 'Clipboard access was unavailable. The command is selected for manual copying.';
      }
      resetLabel = setTimeout(() => { button.textContent = label; }, 2600);
    });
  }
}
