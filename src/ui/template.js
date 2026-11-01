import { html } from "./markup.js";
import { iconButton } from "./icon-button.js";
import { progressBar } from "./progress-bar.js";
export const panelTemplate = (icon, info) => html`
  <button
    id="launcher"
    type="button"
    aria-label="打开学习助手"
    aria-expanded="false"
    aria-controls="panel"
  >
    ${icon("menu", 22)}
  </button>
  <section
    id="panel"
    role="dialog"
    aria-modal="false"
    aria-labelledby="panel-title"
    tabindex="-1"
    hidden
  >
    <header>
      <div class="panel-heading"><h2 id="panel-title">学习助手</h2></div>
      <div class="header-actions">
        <span id="refresh-countdown" role="timer" aria-live="off" hidden></span>
        ${iconButton({ id: "close-panel", name: "close", size: 18, label: "关闭菜单", title: null })}
      </div>
    </header>
    <div class="body">
      <div id="controls"></div>
      <div class="status-section">
        <div class="status-line" id="status-line" hidden>
          <p id="state" role="status" aria-live="polite" aria-atomic="true">等待开始</p>
        </div>
        <div id="center-progress" hidden>
          <div class="course-progress-head">
            <div class="course-progress-meta">
              <span id="center-progress-label">课程进度</span>
              <time id="center-check-time">—</time>
            </div>
            ${iconButton({ id: "check-course-progress", name: "refresh", label: "手动核对课程进度", disabled: true })}
          </div>
          ${progressBar({ trackId: "center-progress-bar", fillId: "center-progress-fill", label: "平台当前课程进度" })}
        </div>
        <p id="center-status" role="status" aria-live="polite" hidden></p>
        <p id="progress"></p>
      </div>
      <section class="annual" aria-label="学时概览">
        <div class="section-head">
          <div class="section-title">
            学时概览${info("annual-info", "关于学时预计", "分类数字来自平台默认学年已学列表，可能含未完成或未通过考试的课程。平台确认总学时单独显示。")}
          </div>
          ${iconButton({ id: "refresh-annual", className: "refresh", name: "refresh", size: 18, label: "刷新平台学时" })}
        </div>
        <div class="annual-grid">
          <div>
            <span>总学时</span>
            <strong>
              <span id="estimate-total">—</span>
              <small>
                /
                <span id="goal-display-total">90</span>
              </small>
            </strong>
          </div>
          <div>
            <span>专业课程</span>
            <strong>
              <span id="estimate-professional">—</span>
              <small>
                /
                <span id="goal-display-professional">60</span>
              </small>
            </strong>
          </div>
          <div>
            <span>公需合计</span>
            <strong>
              <span id="estimate-public">—</span>
              <small>
                /
                <span id="goal-display-public">18</span>
              </small>
            </strong>
          </div>
        </div>
        <div class="official-meta">
          <span>
            平台确认总学时
            <b id="annual-total">—</b>
          </span>
          <span id="annual-year">平台默认学年：—</span>
        </div>
        <div id="annual-breakdown" hidden></div>
        <p id="learned-summary" role="status" aria-live="polite"></p>
      </section>
      <section class="preferences" aria-label="偏好设置">
        <div class="section-title">偏好设置</div>
        <div class="preference-row">
          <span class="preference-label">
            <span id="mute-icon">${icon("volume", 16)}</span>
            <label for="mute-video">自动静音</label>
            ${info("mute-info", "关于自动静音", "静音主播放器和已识别课件。未支持的课件可以在浏览器标签页右键选择静音网站。")}
          </span>
          <input id="mute-video" type="checkbox" role="switch" aria-label="自动静音视频" />
        </div>
        <div class="preference-row">
          <span class="preference-label">
            ${icon("sun", 15)}
            <label for="keep-awake">防止息屏</label>
          </span>
          <input id="keep-awake" type="checkbox" role="switch" aria-label="防止息屏" />
        </div>
        <div class="preference-row">
          <span class="preference-label">
            ${icon("layers", 16)}
            <label for="neumorphism">新拟态外观</label>
          </span>
          <input id="neumorphism" type="checkbox" role="switch" aria-label="新拟态外观" />
        </div>
        <div class="preference-row" id="pure-neumorphism-row" hidden>
          <label for="pure-neumorphism">同色新拟态（实验）</label>
          <input
            id="pure-neumorphism"
            type="checkbox"
            role="switch"
            aria-label="同色新拟态（实验）"
          />
        </div>
        <div class="preference-row" id="appearance-palette-row" hidden>
          <label for="appearance-palette">Material 3 配色</label>
          <div class="select-wrap appearance-picker">
            <select id="appearance-palette" aria-label="Material 3 配色"></select>
            ${icon("chevron", 16)}
          </div>
        </div>
        <div id="appearance-custom-row" hidden>
          <div class="custom-color-row">
            <label for="appearance-seed-color">种子颜色</label>
            <input
              id="appearance-seed-color"
              type="color"
              value="#6750a4"
              aria-label="选择自定义种子颜色"
            />
            <input
              id="appearance-seed-hex"
              type="text"
              value="#6750a4"
              maxlength="7"
              spellcheck="false"
              autocomplete="off"
              aria-label="自定义种子颜色十六进制色值"
              aria-describedby="appearance-seed-error"
            />
          </div>
          <p id="appearance-seed-error" role="status" aria-live="polite"></p>
        </div>
      </section>
      <div id="dashboard"></div>
      <div id="preview"></div>
      <section class="log-section" aria-labelledby="log-title">
        <details id="log-disclosure" class="log-disclosure">
          <summary class="section-head">
            <div class="section-title" id="log-title">日志</div>
            <div class="log-tools icon-actions">
              ${iconButton({ id: "copy-log", className: "", name: "copy", size: 20, label: "复制日志" })}${iconButton({ id: "clear-log", className: "", name: "trash", size: 20, label: "清空日志" })}
            </div>
          </summary>
          <div id="event-log" role="log" aria-label="运行日志"></div>
          <p id="log-result" role="status" aria-live="polite"></p>
        </details>
      </section>
    </div>
  </section>
`;
