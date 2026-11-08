/* global document, window, navigator */
// Progressive enhancement only. The page works fully without this file.
// Adds "Copy" buttons next to the handoff address, subject, body and the prompt.
(function () {
  "use strict";

  if (!navigator.clipboard || !window.isSecureContext) return;

  var EMAIL = "hello@launchpad-marketing-prgqe7.usenaive.ai";

  var status = document.createElement("span");
  status.className = "visually-hidden";
  status.setAttribute("role", "status");
  document.body.appendChild(status);

  function makeButton(getText, label, name) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = label;
    button.setAttribute("aria-label", "Copy " + name);

    button.addEventListener("click", function () {
      navigator.clipboard.writeText(getText()).then(
        function () {
          button.textContent = "Copied";
          status.textContent = name.charAt(0).toUpperCase() + name.slice(1) + " copied";
          window.setTimeout(function () {
            button.textContent = label;
            status.textContent = "";
          }, 2000);
        },
        function () {
          button.textContent = "Copy failed";
        },
      );
    });
    return button;
  }

  // Inline values in the handoff packet (address, subject)
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (el) {
    var row = el.closest(".packet__row");
    var name = row ? row.querySelector("dt").textContent.toLowerCase() : "value";
    if (name === "to") name = "address";
    el.parentNode.appendChild(
      makeButton(
        function () {
          return el.getAttribute("data-copy");
        },
        "Copy",
        name,
      ),
    );
  });

  // Blocks: the email body template and the prompt for the agent
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy-block]"), function (el) {
    var isPrompt = el.classList.contains("prompt__text");
    var button = makeButton(
      function () {
        return el.textContent.trim();
      },
      "Copy",
      isPrompt ? "prompt" : "email body",
    );
    if (isPrompt) {
      el.parentNode.querySelector(".prompt__label").appendChild(button);
    } else {
      el.parentNode.appendChild(button);
    }
  });

  // The address in the closing section
  var wrap = document.querySelector("[data-copy-wrap]");
  if (wrap)
    wrap.appendChild(
      makeButton(
        function () {
          return EMAIL;
        },
        "Copy address",
        "address",
      ),
    );
})();
