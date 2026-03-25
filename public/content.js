(() => {
  const ext = typeof browser !== "undefined" ? browser : chrome;

  const FOLLOW_MENU_ITEM_ID = "hit-the-bell-follow-menu-item";

  function showToast(message, type) {
    const colors = {
      success: "#4CAF50",
      error: "#f44336",
      info: "#2196F3",
    };

    const toast = document.createElement("div");
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: ${colors[type] || colors.info};
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-family: sans-serif;
      z-index: 999999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      opacity: 1;
      transition: opacity 0.3s;
    `;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function listenForToasts() {
    ext.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "SHOW_TOAST") return;
      showToast(message.message, message.level);
    });
  }

  async function followCurrentChannel() {
    try {
      const result = await ext.runtime.sendMessage({
        type: "FOLLOW_CHANNEL_FROM_CONTEXT",
        pageUrl: window.location.href,
      });

      if (result && result.channel && result.channel.name) {
        showToast(`Now following ${result.channel.name}`, "success");
        return;
      }

      showToast("Channel followed.", "success");
    } catch (error) {
      showToast(
        error && error.message ? error.message : "Follow failed.",
        "error",
      );
    }
  }

  function findMenuList() {
    return (
      document.querySelector("ytd-menu-popup-renderer tp-yt-paper-listbox") ||
      document.querySelector("tp-yt-paper-listbox")
    );
  }

  function updateMenuLabel(item, text) {
    const label = item.querySelector("yt-formatted-string");
    if (label) {
      label.textContent = text;
    }
  }

  function injectFollowMenuItem() {
    const list = findMenuList();
    if (!list) return;
    if (list.querySelector(`#${FOLLOW_MENU_ITEM_ID}`)) return;

    const firstItem = list.querySelector("ytd-menu-service-item-renderer");
    if (!firstItem) return;

    const clone = firstItem.cloneNode(true);
    clone.id = FOLLOW_MENU_ITEM_ID;
    clone.removeAttribute("hidden");
    clone.setAttribute("role", "menuitem");

    updateMenuLabel(clone, "Follow Channel");

    clone.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      followCurrentChannel();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    list.insertBefore(clone, list.firstChild);
  }

  const observer = new MutationObserver(() => {
    injectFollowMenuItem();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  listenForToasts();
  injectFollowMenuItem();
})();
