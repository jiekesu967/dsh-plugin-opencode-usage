/**
 * dsh-plugin-opencode-usage:OpenCode Go 用量悬浮面板(Client 半,浏览器 bundle)。
 *
 * 注册 `conversation.input.left` 列表槽位(id="opencode-usage"),入口按钮
 * 位于会话输入栏左下角(加号/计划模式左侧),不占用侧边栏 footer 入口,避免
 * 与其他会话级插件抢占侧边栏底部空间。点击后弹出固定悬浮面板,展示订阅
 * 套餐的滚动 / 每周 / 每月:总额度、已用、剩余、使用百分比与重置时间;
 * 面板打开期间每 60s 自动刷新。
 *
 * 纯 JS + React.createElement,与 team-studio 的 client bundle 同构,无构建步骤。
 * @module dsh-plugin-opencode-usage/client
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-opencode-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var NS = "opencodeUsage";
    var inject = ["slots", "locale"];

    var REFRESH_MS = 60_000;

    var CSS = [
      ".ou_layer{flex:none;align-items:center;min-width:0;display:inline-flex;position:relative}",
      ".ou_footerButtons{align-items:center;min-width:0;display:inline-flex}",
      ".ou_badge{height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-button-ghost-active-fill);border:none;border-radius:999px;align-items:center;gap:6px;padding:0 10px;font-family:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;overflow:hidden}",
      ".ou_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
      ".ou_badge[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".ou_badgeIcon{color:var(--dsw-alias-state-business-primary);flex:none;justify-content:center;align-items:center;display:inline-flex}",
      ".ou_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
      ".ou_badgeMeta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:2px;font-size:11px;line-height:16px}",
      ".ou_panel{z-index:35;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:min(392px,calc(100vw - 24px));max-height:min(74vh,640px);box-shadow:var(--dsw-shadow-lv2);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:14px;flex-direction:column;display:flex;position:fixed;bottom:128px;left:12px;overflow:hidden;transition:left var(--ds-transition-duration-slow) var(--ds-ease-in-out),bottom var(--ds-transition-duration-slow) var(--ds-ease-in-out),width var(--ds-transition-duration-slow) var(--ds-ease-in-out)}",
      ".ou_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex:none;justify-content:space-between;align-items:center;min-height:46px;padding:10px 12px;display:flex}",
      ".ou_title{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}",
      ".ou_subtitle{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;line-height:16px}",
      ".ou_close{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}",
      ".ou_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
      ".ou_body{flex:1;min-height:0;padding:12px;overflow-y:auto}",
      ".ou_cards{flex-direction:column;gap:10px;display:flex}",
      ".ou_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px}",
      ".ou_cardHead{justify-content:space-between;align-items:baseline;gap:10px;display:flex}",
      ".ou_cardTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}",
      ".ou_cardWindow{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
      ".ou_remaining{color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-variant-numeric:tabular-nums;font-size:26px;font-weight:600;line-height:34px;margin-top:6px}",
      ".ou_remainingUnit{color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:12px;font-weight:400}",
      ".ou_usedLine{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px;margin-top:2px}",
      ".ou_progress{background:var(--dsw-alias-bg-layer-1);height:8px;border-radius:999px;margin-top:10px;overflow:hidden}",
      ".ou_progressFill{height:100%;width:0;background:var(--dsw-alias-state-business-primary);border-radius:999px;transition:width .2s var(--ds-ease-in-out)}",
      ".ou_progressFill[data-level=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".ou_progressFill[data-level=danger]{background:var(--dsw-alias-state-error-primary)}",
      ".ou_reset{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;line-height:16px;margin-top:8px}",
      ".ou_limited{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);border-radius:6px;align-self:flex-start;padding:1px 7px;font-size:11px;line-height:18px;margin-top:8px}",
      ".ou_status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
      ".ou_failure{color:var(--dsw-alias-state-error-primary);flex-direction:column;align-items:flex-start;gap:8px;display:flex}",
      ".ou_failure p{margin:0;font-size:13px;line-height:20px}",
      ".ou_failure button{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px}",
      "@media (prefers-reduced-motion:no-preference){.ou_progressFill{transition:width .2s var(--ds-ease-in-out)}}",
    ].join("");

    var TAG_ID = "dsh-plugin-opencode-usage/OpenCodeUsagePanel.css";
    if (
      typeof document !== "undefined" &&
      document.querySelector('style[data-plugin-css="' + TAG_ID + '"]') === null
    ) {
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = "dsh-plugin-opencode-usage";
      styleTag.dataset.pluginCss = TAG_ID;
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    var moneyFormat = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    var numberFormat = new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 1,
    });

    function formatMoney(value, currency) {
      return String(currency || "$") + moneyFormat.format(Number(value) || 0);
    }

    function formatPercent(value) {
      return numberFormat.format(Number(value) || 0) + "%";
    }

    function formatTime(value) {
      var date = new Date(value);
      return (
        String(date.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(date.getDate()).padStart(2, "0") +
        " " +
        String(date.getHours()).padStart(2, "0") +
        ":" +
        String(date.getMinutes()).padStart(2, "0")
      );
    }

    function progressLevel(period) {
      if (period.percent >= 100) return "danger";
      if (period.percent >= 80) return "warn";
      return "ok";
    }

    function UsageIcon() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          "aria-hidden": "true",
        },
        React.createElement("path", {
          d: "M2.5 13.5v-3M6.5 13.5v-6M10.5 13.5v-8M14 13.5v-4",
          strokeLinecap: "round",
        }),
      );
    }

    function CloseIcon() {
      return React.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          "aria-hidden": "true",
        },
        React.createElement("path", { d: "M4 4l8 8M12 4l-8 8", strokeLinecap: "round" }),
      );
    }

    function PeriodCard(props) {
      var period = props.period;
      var t = props.t;
      var level = progressLevel(period);
      return React.createElement(
        "section",
        { className: "ou_card", "data-period": period.key },
        React.createElement(
          "div",
          { className: "ou_cardHead" },
          React.createElement("span", { className: "ou_cardTitle" }, t(period.key + "Title")),
          React.createElement(
            "span",
            { className: "ou_cardWindow" },
            t(period.key + "Window"),
          ),
        ),
        React.createElement(
          "div",
          { className: "ou_remaining" },
          formatMoney(period.remaining, period.currency),
          React.createElement("span", { className: "ou_remainingUnit" }, t("remaining")),
        ),
        React.createElement(
          "div",
          { className: "ou_usedLine" },
          t("usedOfTotal", {
            used: formatMoney(period.used, period.currency),
            total: formatMoney(period.limit, period.currency),
            percent: formatPercent(period.percent),
          }),
        ),
        React.createElement(
          "div",
          {
            className: "ou_progress",
            role: "progressbar",
            "aria-label": t(period.key + "Title"),
            "aria-valuenow": String(Math.max(0, Math.min(100, period.percent))),
            "aria-valuemin": "0",
            "aria-valuemax": "100",
          },
          React.createElement("div", {
            className: "ou_progressFill",
            "data-level": level,
            style: { width: String(Math.max(0, Math.min(100, period.percent))) + "%" },
          }),
        ),
        period.resetsAt
          ? React.createElement(
              "div",
              { className: "ou_reset" },
              t("resetsAt", { time: formatTime(period.resetsAt) }),
            )
          : null,
        period.percent >= 100
          ? React.createElement("div", { className: "ou_limited" }, t("limitReached"))
          : null,
      );
    }

    function OpenCodeUsagePanel(props) {
      var t = props.t;
      var panelId = React.useId();
      var rootRef = React.useRef(null);
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var requestState = React.useState(0);
      var request = requestState[0];
      var setRequest = requestState[1];
      var stateState = React.useState({ status: "idle" });
      var state = stateState[0];
      var setState = stateState[1];
      var placementState = React.useState(null);
      var placement = placementState[0];
      var setPlacement = placementState[1];

      var PANEL_MAX_WIDTH = 392;
      var VIEWPORT_GAP = 12;
      var BUTTON_GAP = 12;

      /**
       * 以会话输入栏左下角按钮为锚点定位面板:
       * 左边缘与按钮对齐,面板底部位于按钮上方 12px;超视口时自动回退。
       */
      function computePlacement() {
        var rect = rootRef.current ? rootRef.current.getBoundingClientRect() : null;
        var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        var width = Math.min(PANEL_MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_GAP * 2));
        var left = rect ? rect.left : VIEWPORT_GAP;
        left = Math.max(VIEWPORT_GAP, Math.min(left, viewportWidth - width - VIEWPORT_GAP));
        var bottom = rect
          ? Math.max(VIEWPORT_GAP, Math.min(viewportHeight - VIEWPORT_GAP, viewportHeight - rect.top + BUTTON_GAP))
          : 128;
        return {
          left: Math.round(left),
          bottom: Math.round(bottom),
          width: Math.round(width),
        };
      }

      function updatePlacement() {
        setPlacement(computePlacement());
      }

      function toggleOpen() {
        var next = !open;
        if (next) updatePlacement();
        setOpen(next);
      }

      React.useEffect(
        function () {
          if (!open) return;
          var current = true;
          setState({ status: "loading" });
          Promise.resolve()
            .then(function () {
              return fetch("/plugins/opencode-usage/stats", { cache: "no-store" });
            })
            .then(function (res) {
              if (!res.ok) throw new Error("opencode-usage stats failed: " + res.status);
              return res.json();
            })
            .then(
              function (snapshot) {
                if (!current) return;
                if (!snapshot || snapshot.ok !== true) {
                  throw new Error(snapshot && snapshot.error ? snapshot.error : "invalid snapshot");
                }
                setState({ status: "ready", snapshot: snapshot });
              },
              function (error) {
                if (current) setState({ status: "error", message: String(error?.message ?? error) });
              },
            );
          return function () {
            current = false;
          };
        },
        [open, request],
      );

      React.useEffect(
        function () {
          if (!open) return;
          var timer = window.setInterval(function () {
            setRequest(function (value) {
              return value + 1;
            });
          }, REFRESH_MS);
          return function () {
            window.clearInterval(timer);
          };
        },
        [open],
      );

      React.useEffect(
        function () {
          if (!open) return;
          updatePlacement();
          var target = rootRef.current;
          var observer =
            typeof ResizeObserver !== "undefined" && target
              ? new ResizeObserver(updatePlacement)
              : null;
          if (observer) observer.observe(target);
          window.addEventListener("resize", updatePlacement);
          return function () {
            if (observer) observer.disconnect();
            window.removeEventListener("resize", updatePlacement);
          };
        },
        [open],
      );

      React.useEffect(
        function () {
          if (!open) return;
          function onKey(event) {
            if (event.key === "Escape") setOpen(false);
          }
          function onPointer(event) {
            if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
          }
          document.addEventListener("keydown", onKey);
          document.addEventListener("pointerdown", onPointer);
          return function () {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerdown", onPointer);
          };
        },
        [open],
      );

      function retry() {
        setState({ status: "loading" });
        setRequest(function (value) {
          return value + 1;
        });
      }

      var body = [];
      if (state.status === "idle" || state.status === "loading") {
        body.push(
          React.createElement("p", { className: "ou_status", key: "loading" }, t("loading")),
        );
      }
      if (state.status === "error") {
        body.push(
          React.createElement(
            "div",
            { className: "ou_failure", key: "error" },
            React.createElement("p", { role: "alert" }, t("error") + (state.message ? ": " + state.message : "")),
            React.createElement("button", { type: "button", onClick: retry }, t("retry")),
          ),
        );
      }
      if (state.status === "ready") {
        var periods = state.snapshot.periods;
        var weeklyPeriod = periods.weekly || periods.week;
        var monthlyPeriod = periods.monthly || periods.month;
        body.push(
          React.createElement(
            "div",
            { className: "ou_cards", key: "cards" },
            periods.rolling
              ? React.createElement(PeriodCard, { key: "rolling", period: periods.rolling, t: t })
              : null,
            weeklyPeriod
              ? React.createElement(PeriodCard, { key: "weekly", period: weeklyPeriod, t: t })
              : null,
            monthlyPeriod
              ? React.createElement(PeriodCard, { key: "monthly", period: monthlyPeriod, t: t })
              : null,
          ),
        );
      }

      var rolling = state.status === "ready" ? state.snapshot.periods.rolling : null;

      return React.createElement(
        "div",
        {
          ref: rootRef,
          className: "ou_layer",
        },
        open
          ? React.createElement(
              "section",
              {
                className: "ou_panel",
                id: panelId,
                role: "dialog",
                "aria-label": t("panelTitle"),
                style: placement
                  ? {
                      left: placement.left + "px",
                      bottom: placement.bottom + "px",
                      width: placement.width + "px",
                    }
                  : undefined,
              },
              React.createElement(
                "header",
                { className: "ou_header" },
                React.createElement(
                  "div",
                  null,
                  React.createElement("div", { className: "ou_title" }, t("panelTitle")),
                  state.status === "ready"
                    ? React.createElement(
                        "div",
                        { className: "ou_subtitle" },
                        t("subtitle", {
                          provider: state.snapshot.provider,
                          time: formatTime(state.snapshot.generatedAt),
                        }),
                      )
                    : React.createElement(
                        "div",
                        { className: "ou_subtitle" },
                        t("panelSubtitle"),
                      ),
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "ou_close",
                    "aria-label": t("close"),
                    onClick: function () {
                      setOpen(false);
                    },
                  },
                  React.createElement(CloseIcon),
                ),
              ),
              React.createElement("div", { className: "ou_body" }, body),
            )
          : null,
        React.createElement(
          "div",
          { className: "ou_footerButtons" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "ou_badge",
              "data-open": open ? "true" : "false",
              "aria-label": t("trigger"),
              "aria-expanded": open,
              "aria-controls": open ? panelId : undefined,
              onClick: toggleOpen,
            },
            React.createElement("span", { className: "ou_badgeIcon" }, React.createElement(UsageIcon)),
            React.createElement("span", { className: "ou_badgeLabel" }, t("trigger")),
            rolling
              ? React.createElement(
                  "span",
                  { className: "ou_badgeMeta" },
                  t("triggerMeta", {
                    remaining: formatMoney(rolling.remaining, rolling.currency),
                    percent: formatPercent(rolling.remainingPercent),
                  }),
                )
              : null,
          ),
        ),
      );
    }

    var zh = {
      trigger: "OpenCode Go 用量",
      triggerMeta: "滚动剩余 {remaining}({percent})",
      panelTitle: "OpenCode Go 订阅用量",
      panelSubtitle: "总额度 / 已用 / 剩余",
      subtitle: "{provider} · 更新于 {time}",
      loading: "正在查询订阅用量…",
      error: "暂时无法查询用量",
      retry: "重试",
      close: "关闭",
      rollingTitle: "滚动用量",
      weeklyTitle: "每周用量",
      monthlyTitle: "每月用量",
      rollingWindow: "5 小时滚动窗口",
      weeklyWindow: "自然周窗口",
      monthlyWindow: "自然月窗口",
      remaining: "剩余",
      usedOfTotal: "已用 {used} / 总额 {total} · {percent}",
      resetsAt: "额度重置:{time}",
      limitReached: "已达额度上限",
    };

    var en = {
      trigger: "OpenCode Go usage",
      triggerMeta: "Rolling remaining {remaining} ({percent})",
      panelTitle: "OpenCode Go subscription usage",
      panelSubtitle: "Limit / used / remaining",
      subtitle: "{provider} · updated {time}",
      loading: "Reading subscription usage…",
      error: "Usage is temporarily unavailable",
      retry: "Retry",
      close: "Close",
      rollingTitle: "Rolling usage",
      weeklyTitle: "Weekly usage",
      monthlyTitle: "Monthly usage",
      rollingWindow: "5-hour rolling window",
      weeklyWindow: "Weekly window",
      monthlyWindow: "Monthly window",
      remaining: "remaining",
      usedOfTotal: "Used {used} / limit {total} · {percent}",
      resetsAt: "Resets at {time}",
      limitReached: "Limit reached",
    };

    function apply(ctx) {
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        "opencode-usage: dictionaries",
      );

      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "opencode-usage",
            order: 0,
            locale: NS,
          },
          OpenCodeUsagePanel,
        );
      });
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
