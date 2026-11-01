import { settingDefault } from "../settings-schema.js";
import { html } from "./markup.js";
import { progressBar } from "./progress-bar.js";
export function mountControllerControls({ $, icon, info }) {
  $("#center-progress").hidden = false;
  $("#controls").innerHTML = html`
    <div class="label-row">
      <label for="target">学习目标</label>
      ${info("target-info", "关于学习目标", "达到总数时，自动类别需同时满足目标总数及设置中的专业、公需要求；指定类别只计算该类别。新增数量以本轮列表增量为基数。")}
    </div>
    <div class="input-row" id="round-target">
      <div class="target-wrap">
        <input id="target" type="text" inputmode="decimal" value="${settingDefault("target")}" />
        <span class="suffix" id="target-unit">学时</span>
      </div>
    </div>
    <div class="select-wrap">
      <select id="targetMode" class="goal-mode" aria-label="目标方式">
        <option value="absolute" ${settingDefault("targetMode") === "absolute" ? "selected" : ""}>
          达到总数
        </option>
        <option value="increment" ${settingDefault("targetMode") === "increment" ? "selected" : ""}>
          新增数量
        </option>
      </select>
      ${icon("chevron", 16)}
    </div>
    <div class="category-row">
      <span class="select-wrap">
        <select id="category" aria-label="选择课程类别">
          <option value="auto" ${settingDefault("category") === "auto" ? "selected" : ""}>
            自动选择类别
          </option>
          <option value="专业课程" ${settingDefault("category") === "专业课程" ? "selected" : ""}>
            专业课程
          </option>
          <option value="行业公需" ${settingDefault("category") === "行业公需" ? "selected" : ""}>
            行业公需
          </option>
          <option value="一般公需" ${settingDefault("category") === "一般公需" ? "selected" : ""}>
            一般公需
          </option>
        </select>
        ${icon("chevron", 16)}
      </span>
      <button type="button" id="read-next">查找</button>
    </div>
    <div class="actions" id="scheduler-actions">
      <button type="button" id="plan">查找并安排课程</button>
      <button type="button" class="primary" id="start" aria-label="开始学习" disabled>
        ${icon("play", 20)}
        <span>开始学习</span>
      </button>
    </div>
    <details>
      <summary>设置</summary>
      <div class="advanced">
        <div class="preference-row">
          <span class="preference-label">
            <label for="annual-limit">新增模式按年度分类要求调度</label>
          </span>
          <input
            id="annual-limit"
            type="checkbox"
            role="switch"
            ${settingDefault("annual-limit") ? "checked" : ""}
          />
        </div>
        <div class="annual-goals" id="annual-goals">
          <div class="field" id="annual-total-field">
            <label for="goal-total">年度总学时</label>
            <input
              id="goal-total"
              type="text"
              inputmode="decimal"
              value="${settingDefault("goal-total")}"
            />
          </div>
          <div class="field">
            <label for="goal-professional">专业课程学时</label>
            <input
              id="goal-professional"
              type="text"
              inputmode="decimal"
              value="${settingDefault("goal-professional")}"
            />
          </div>
          <div class="field">
            <label for="goal-public">行业与一般公需合计</label>
            <input
              id="goal-public"
              type="text"
              inputmode="decimal"
              value="${settingDefault("goal-public")}"
            />
          </div>
        </div>
        <div class="field">
          <div class="setting-label">
            <label for="maxMinutes">时长上限（分钟）</label>
            ${info("duration-info", "关于时长上限", "按单门课程总时长筛选。0.5学时等小课也参与排序。")}
          </div>
          <input
            id="maxMinutes"
            type="text"
            inputmode="decimal"
            value="${settingDefault("maxMinutes")}"
          />
        </div>
        <div class="field">
          <div class="setting-label">
            <label for="maxRatio">每学时上限（分钟）</label>
            ${info("ratio-info", "关于每学时上限", "预计剩余分钟数除以课程学时，严格小于该数值才加入计划。")}
          </div>
          <input
            id="maxRatio"
            type="text"
            inputmode="decimal"
            value="${settingDefault("maxRatio")}"
          />
        </div>
        <div class="field time">
          <div class="setting-label">
            <label for="window" id="window-current">开课时段：全天</label>
            ${info("window-info", "关于开课时段", "留空表示全天。只限制新开课时间，当前课程会继续学习。")}
          </div>
          <input
            id="window"
            value="${settingDefault("window")}"
            type="text"
            placeholder="例如 19:00-23:00"
            aria-label="新开课时段，留空全天"
          />
        </div>
        <div class="preference-row">
          <span class="preference-label">
            <label for="auto">自动继续学习</label>
            ${info("continue-info", "关于自动继续", "自动处理已识别的续播提示。需要你处理的其他提示可在日志中查看。")}
          </span>
          <input
            id="auto"
            type="checkbox"
            role="switch"
            ${settingDefault("auto") ? "checked" : ""}
          />
        </div>
        <div class="preference-row">
          <span class="preference-label">
            <label for="auto-refresh">定时刷新主页面</label>
            ${info("auto-refresh-info", "关于定时刷新", "只刷新调度主页面，学习期间按间隔执行；页面刷新不保证登录续期，恢复失败会等待手动处理。")}
          </span>
          <input
            id="auto-refresh"
            type="checkbox"
            role="switch"
            ${settingDefault("auto-refresh") ? "checked" : ""}
          />
        </div>
        <div class="field">
          <label for="refresh-minutes">刷新间隔（分钟）</label>
          <input
            id="refresh-minutes"
            type="text"
            inputmode="decimal"
            value="${settingDefault("refresh-minutes")}"
          />
        </div>
        <div class="settings-actions">
          <button type="button" id="reset" class="reset">从第1页重新读取</button>
          <button type="button" class="reset" id="sync-history">同步平台已学</button>
        </div>
        <p id="history-progress" role="status" aria-live="polite"></p>
      </div>
    </details>
    <details id="history-details" hidden>
      <summary>排除</summary>
      <div id="records"></div>
    </details>
  `;
  $("#dashboard").innerHTML = html`
    <div class="stats">
      <div class="stat">
        <span>本轮列表增量</span>
        <strong id="earned">0</strong>
        <small id="earned-unit">学时</small>
      </div>
      <div class="stat">
        <span>计划待学</span>
        <strong id="queued">0</strong>
        <small>门</small>
      </div>
    </div>
    <div class="round-progress">
      ${progressBar({ trackId: "round-progress-bar", fillId: "bar", label: "本轮学习目标进度" })}
    </div>
  `;
}
export function mountPlayerControls({ $, icon }) {
  $("#center-progress").hidden = true;
  $("#controls").innerHTML = html`
    <div class="worker-actions">
      <button
        type="button"
        class="primary playback-toggle"
        id="playback-toggle"
        aria-label="继续播放"
      >
        ${icon("play", 20)}
        <span>继续播放</span>
      </button>
    </div>
    <div class="manual-buttons pill-actions">
      <button
        type="button"
        id="worker-learned"
        class="quiet-action"
        title="已学，跳过此课"
        aria-label="已学，跳过此课"
      >
        ${icon("check", 18)}
      </button>
      <button
        type="button"
        id="worker-remove"
        class="quiet-action"
        title="移除此课"
        aria-label="移除此课"
      >
        ${icon("trash", 18)}
      </button>
    </div>
  `;
}
