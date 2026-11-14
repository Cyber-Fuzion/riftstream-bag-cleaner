// Serve apenas como relogio: responde depois de N ms, para a extensao continuar andando com a aba oculta.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && typeof msg.rsbSleep === 'number') {
    setTimeout(() => { try { sendResponse(true); } catch (e) {} }, Math.min(Math.max(msg.rsbSleep, 0), 60000));
    return true;
  }
});
