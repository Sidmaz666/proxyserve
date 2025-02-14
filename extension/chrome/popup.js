document.addEventListener("DOMContentLoaded", function () {
  const toggleBtn = document.getElementById("toggleBtn");
  const statusText = document.getElementById("statusText");

  // Initialize state from storage (default off)
  chrome.storage.sync.get(["proxyActive"], function (result) {
    const active = result.proxyActive || false;
    updateUI(active);
  });

  toggleBtn.addEventListener("click", function () {
    chrome.storage.sync.get(["proxyActive"], function (result) {
      const active = !result.proxyActive; // toggle state
      chrome.storage.sync.set({ proxyActive: active }, function () {
        updateUI(active);
        // Inform background to update proxy settings
        chrome.runtime.sendMessage({
          action: active ? "activate" : "deactivate",
        });
      });
    });
  });

  function updateUI(active) {
    if (active) {
      toggleBtn.textContent = "Disable Proxy";
      statusText.textContent = "Proxy is active";
      toggleBtn.classList.remove("bg-blue-500");
      toggleBtn.classList.add("bg-red-500");
    } else {
      toggleBtn.textContent = "Activate Proxy";
      statusText.textContent = "Proxy is off";
      toggleBtn.classList.remove("bg-red-500");
      toggleBtn.classList.add("bg-blue-500");
    }
  }
});
