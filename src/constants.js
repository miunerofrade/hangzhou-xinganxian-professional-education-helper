export const ORIGIN = "https://learning.hzrs.hangzhou.gov.cn";
export const PREFIX = "[杭州学习助手]";
export const CHANNEL = "hz-learning-helper-v1";
export const configKey = (run) => `hz-helper:${run}`;
export const route = () => location.hash.split("?")[0].toLowerCase();
export const courseId = () =>
  new URLSearchParams(location.hash.split("?")[1] || "").get("courseId");

export const closeApprovalKey = (run, job) => `hz-helper-close-approved:${run}:${job}`;

export const COURSE_ORIGIN = "https://xc-course.hzrs.hangzhou.gov.cn";

export const FRAME_ORIGINS = [ORIGIN, COURSE_ORIGIN, `${COURSE_ORIGIN}:5443`];

export const ACTION_DELAY_MS = 2000;
