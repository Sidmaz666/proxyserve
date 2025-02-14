// Configure your forward proxy server here.
const PROXY_SERVER = {
  scheme: "http", // Use "http" for the proxy server's protocol (the forward proxy listens over HTTP)
  host: "localhost", // Replace with your proxy server's address
  port: parseInt("3000", 10)
};

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === "activate") {
    // Set Chrome proxy settings to use the forward proxy server.
    const config = {
      mode: "fixed_servers",
      rules: {
        singleProxy: PROXY_SERVER,
        bypassList: ["<local>"]
      }
    };
    chrome.proxy.settings.set(
      { value: config, scope: "regular" },
      function () {
        console.log("Proxy activated:", config);
      }
    );
  } else if (message.action === "deactivate") {
    // Clear proxy settings (direct connection)
    const config = { mode: "direct" };
    chrome.proxy.settings.set(
      { value: config, scope: "regular" },
      function () {
        console.log("Proxy deactivated");
      }
    );
  }
});
