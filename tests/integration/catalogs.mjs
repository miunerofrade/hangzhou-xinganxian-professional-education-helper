import assert from "node:assert/strict";
import { normalizeCourse } from "../../src/planner.js";

export const catalogResponse = (url, body) => {
  if (url.endsWith("/Course/index"))
    return { status: 200, data: { data: [], current_page: 1, per_page: 100, total: 0 } };
  if (url.endsWith("/getCourseInfo")) return { status: 200, data: { examtype: "W" } };
  const rows = [
    {
      courseid: `p${body.page}`,
      coursename: `page ${body.page}`,
      period: 0.5,
      coursetimes: 1200,
      examtype_text: "无",
    },
    {
      courseid: "repeat",
      coursename: "duplicate",
      period: 1,
      coursetimes: 2520,
      examtype_text: "无",
    },
  ];
  return { status: 200, course: { data: rows, current_page: body.page, per_page: 30, total: 360 } };
};

export const shortCourse = normalizeCourse({
  courseid: 1,
  coursename: "short",
  period: 0.5,
  coursetimes: 1200,
});

export const exactly45 = { ...shortCourse, id: "exact", hours: 1, duration: 2700, remaining: 2700 };

export const historyResponse = (url, body) => {
  if (url.endsWith("/myStudyList"))
    return {
      status: 200,
      year: [
        { schoolyearid: "2026", yeartitle: "2026学年" },
        { schoolyearid: "2025", yeartitle: "2025学年" },
      ],
      data: {
        data: [
          {
            courseid: body.schoolyearid === "2025" ? "p2" : "p1",
            coursename: "Already studied",
            examtype: "W",
            period: 0.5,
            coursetype_text: "一般公需",
          },
        ],
        total: 1,
        per_page: 100,
        current_page: body.page,
      },
    };
  return catalogResponse(url, body);
};

export const groupedResponse = (url, body) => {
  if (url.endsWith("/Study.UserIndex/index"))
    return {
      status: 200,
      data: {
        study: [
          { typeid: 0, s: 0, r: 90 },
          { typeid: 1, coursetype: "专业课程", s: 0, r: 60 },
          { typeid: 2, coursetype: "行业公需", s: 0 },
          { typeid: 3, coursetype: "一般公需", s: 0 },
        ],
      },
    };
  if (url.endsWith("/myStudyList"))
    return {
      status: 200,
      year: [{ schoolyearid: "2026", yeartitle: "2026学年" }],
      data: { data: [], current_page: 1, per_page: 100, total: 0 },
    };
  if (url.endsWith("/Course/index"))
    return { status: 200, data: { data: [], current_page: 1, per_page: 100, total: 0 } };
  if (url.endsWith("/getCourseInfo")) return { status: 200, data: { examtype: "W" } };
  const types = [
    { typeid: 9, coursetype: "专业课程" },
    { typeid: 15, coursetype: "行业公需" },
    { typeid: 7, coursetype: "一般公需" },
  ];
  const entries = [
    {
      courseid: "p",
      coursename: "专业",
      period: 1,
      coursetimes: 1200,
      examtype_text: "无",
      coursetype: "专业课程",
    },
    {
      courseid: "i",
      coursename: "公需",
      period: 1,
      coursetimes: 600,
      examtype_text: "无",
      coursetype: "行业公需",
    },
    {
      courseid: "u",
      coursename: "未知",
      period: 1,
      coursetimes: 600,
      examtype_text: "无",
      coursetype: "未识别",
    },
  ];
  const wanted = types.find((t) => String(t.typeid) === String(body.type))?.coursetype;
  const filtered = wanted ? entries.filter((e) => e.coursetype === wanted) : entries;
  return {
    status: 200,
    type: types,
    course: {
      data: body.page === 1 ? filtered : [],
      current_page: body.page,
      per_page: 30,
      total: filtered.length,
    },
  };
};

export const generalFallback = (url, body) => {
  if (!url.endsWith("/SelectCourse")) return groupedResponse(url, body);
  const types = [
    { typeid: 9, coursetype: "专业课程" },
    { typeid: 15, coursetype: "行业公需" },
    { typeid: 7, coursetype: "一般公需" },
  ];
  const rows =
    body.type === 7
      ? [
          {
            courseid: "general",
            coursename: "一般公需课程",
            period: 0.5,
            coursetimes: 900,
            examtype_text: "无",
            coursetype: "一般公需",
          },
        ]
      : [];
  return {
    status: 200,
    type: types,
    course: { data: rows, current_page: body.page, per_page: 30, total: rows.length },
  };
};

export const listedResponse = (url, body) => {
  if (url.endsWith("/Study.UserIndex/index"))
    return {
      status: 200,
      data: {
        study: [
          { typeid: 0, s: 0 },
          { typeid: 9, coursetype: "专业课程", s: 0 },
          { typeid: 15, coursetype: "行业公需", s: 0 },
          { typeid: 7, coursetype: "一般公需", s: 0 },
        ],
      },
    };
  if (url.endsWith("/myStudyList")) {
    const years = [
      { schoolyearid: "2026", yeartitle: "2026" },
      { schoolyearid: "2025", yeartitle: "2025" },
    ];
    if (!body.schoolyearid) return { status: 200, year: years };
    assert.equal(body.schoolyearid, "2026", "summary must not mix previous years");
    const data =
      body.page === 1
        ? [
            { courseid: "a", period: "0.50", coursetype_text: "一般公需" },
            { courseid: "b", period: "0.50", coursetype_text: "一般公需" },
          ]
        : [{ courseid: "c", period: "1.00", coursetype_text: "一般公需" }];
    return {
      status: 200,
      year: years,
      data: { data, total: 3, current_page: body.page, per_page: 2 },
    };
  }
  return groupedResponse(url, body);
};
