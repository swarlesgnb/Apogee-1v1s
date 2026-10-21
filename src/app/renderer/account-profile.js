(() => {
  const api = window.apogee;
  if (!api || !api.updateName) return;
  const byId = id => document.getElementById(id);
  const dialog = byId('profileDialog');
  const input = byId('profileName');
  const save = byId('profileSave');
  const cancel = byId('profileCancel');
  let session = null;
  let busy = false;
  function validate() {
    const name = input.value.trim();
    const valid = [...name].length >= 2 && [...name].length <= 32 && !/[\x00-\x1f\x7f-\x9f]/.test(name);
    save.disabled = busy || !valid || name === session?.displayName;
    input.disabled = busy;
    cancel.disabled = busy;
  }
  function paintSession(value) {
    session = value;
    byId('btnEditName').hidden = !value;
    byId('btnRestoreCloud').hidden = !value;
    if (!value) byId('cloudHistoryStatus').textContent = '';
    if (!value && dialog.open) dialog.close();
  }
  function paintHistory(value) {
    const status = value || {count: 0, status: 'idle'};
    byId('btnRestoreCloud').disabled = status.status === 'loading';
    byId('btnRestoreCloud').textContent = status.status === 'loading' ? 'Restoring history…' : 'Restore saved history';
    byId('cloudHistoryStatus').textContent = !session ? '' : status.status === 'loading'
      ? 'Restoring your saved scores and scenario history…'
      : status.status === 'error' ? 'Could not refresh saved history. ' + (status.error || 'Try again.')
      : status.status === 'ready' ? `${status.count.toLocaleString()} saved runs available, combined with your local CSV history. Original CSV files are not downloaded.` : '';
  }
  function openEditor() {
    if (!session) return;
    input.value = session.displayName;
    byId('profileStatus').textContent = '';
    validate();
    if (!dialog.open) dialog.showModal();
    input.focus(); input.select();
  }
  byId('accountName').addEventListener('click', openEditor);
  byId('btnEditName').addEventListener('click', openEditor);
  input.addEventListener('input', validate);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  byId('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    busy = true; validate();
    byId('profileStatus').textContent = 'Saving…';
    try {
      const result = await api.updateName(input.value);
      if (result.error) byId('profileStatus').textContent = result.error;
      else { paintSession(result.session); dialog.close(); if (typeof showNotice === 'function') showNotice('Apogee name saved.'); }
    } catch (error) { byId('profileStatus').textContent = error.message || 'Could not save your name. Try again.'; }
    finally { busy = false; validate(); }
  });
  byId('btnRestoreCloud').addEventListener('click', async () => {
    paintHistory({status: 'loading', count: 0});
    try { paintHistory(await api.restoreCloudHistory()); }
    catch (error) { paintHistory({status: 'error', error: error.message}); }
  });
  api.onSession(paintSession);
  api.onCloudHistory(paintHistory);
  api.getState().then(state => {paintSession(state.session); paintHistory(state.cloudHistory);}).catch(() => {});
})();
