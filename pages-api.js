const examRoutes = "/api/exams/2121142069793841152"
const bankRoutes = "/api/problem-sets/2121133349609480192"
const storagePrefix = "pta-pages:"
const compareLabels = new Intl.Collator("zh-CN", { numeric: true })
const runs = new Map()
let bankRequest

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(storagePrefix + key)) ?? fallback }
  catch { return fallback }
}

function write(key, value) {
  try { localStorage.setItem(storagePrefix + key, JSON.stringify(value)) }
  catch { throw new Error("浏览器存储空间不足或已禁用") }
}

async function loadBank() {
  bankRequest ??= fetch("/questions.json").then(response => {
    if (!response.ok) throw new Error("题库加载失败")
    return response.json()
  }).catch(error => {
    bankRequest = undefined
    throw error
  })
  return bankRequest
}

async function questions() {
  const bank = await loadBank()
  const { added, deleted } = read("questions", { added: [], deleted: [] })
  return [...bank.problems, ...added]
    .filter(question => !deleted.includes(question.id))
    .sort((a, b) => (a.bankOrder ?? 0) - (b.bankOrder ?? 0) || compareLabels.compare(a.label, b.label))
}

function summary({ id, label, title, type, score, sampleOnly }) {
  return { id, label, title, type, score, sampleOnly }
}

function importedQuestion(item) {
  if (!/^\d{1,32}$/.test(item.pid)) throw new Error("pid 必须是数字字符串")
  const content = item.stem.trim()
  if (!content) throw new Error("题面不能为空")
  if (!Number.isInteger(item.score) || item.score <= 0) throw new Error("分数必须是正整数")
  const options = item.options ?? []
  if (!Array.isArray(options) || options.some(option =>
    typeof option?.value !== "string" || !option.value || typeof option.text !== "string"
  ) || new Set(options.map(option => option.value)).size !== options.length) {
    throw new Error("选项格式无效，或选项编号重复")
  }
  const correctAnswer = typeof item.correctAnswer === "string" ? item.correctAnswer.trim() : ""
  let type = "IMPORTED_REVIEW"
  if ([item.typeLabel, item.sourceType].includes("程序填空题")) type = "PROGRAM_FILL_IN"
  else if ((item.type === "single" || item.typeLabel === "单选题") && options.length &&
           (!correctAnswer || options.some(option => option.value === correctAnswer))) type = "SINGLE_CHOICE"
  return {
    id: item.pid, label: ["string", "number"].includes(typeof item.qno) ? String(item.qno).trim().slice(0, 64) || "未编号" : "未编号",
    type, title: content.split(/\r?\n/, 1)[0].slice(0, 100), content,
    score: item.score, options, correctAnswer,
    typeLabel: typeof item.typeLabel === "string" ? item.typeLabel : "",
  }
}

function startRun(detail) {
  const { program, compiler } = detail.programmingSubmissionDetail
  const stdin = detail.customTestData?.content ?? ""
  if (!program.trim()) throw new Error("请先输入 Java 代码")
  if (compiler !== "JAVAC") throw new Error("在线评测仅支持 Java")
  if (new TextEncoder().encode(program).length > 16 * 1024) throw new Error("代码不能超过 16 KB")
  const submissionId = crypto.randomUUID()
  const submission = {
    id: submissionId, status: "JUDGING", submissionDetails: [detail],
    compiler, submitAt: new Date().toISOString(), judgeResponseContents: [],
  }
  runs.set(submissionId, { submission })

  void fetch("https://wandbox.org/api/compile.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ compiler: "openjdk-jdk-21+35", code: program, stdin, save: false }),
    signal: AbortSignal.timeout(45000),
  }).then(async response => {
    if (response.status === 429) throw new Error("评测请求过多，请稍后重试")
    if (!response.ok) throw new Error("在线评测服务暂不可用")
    const result = await response.json()
    const compilerLog = result.compiler_message || ""
    if (/OCI runtime error|Resource temporarily unavailable|Internal Server Error/i.test(compilerLog)) {
      throw new Error("在线评测服务暂不可用，请稍后重试")
    }
    if (!/^\d+$/.test(result.status ?? "") && !result.signal) {
      throw new Error("评测服务未返回有效结果，请稍后重试")
    }
    const compileError = Boolean(result.compiler_error) && Number(result.status) !== 0
    submission.status = compileError ? "COMPILE_ERROR" : "NEUTRAL"
    submission.judgeAt = new Date().toISOString()
    submission.judgeResponseContents = [{
      status: submission.status,
      programmingJudgeResponseContent: {
        compilationResult: { success: !compileError, log: compilerLog },
        testcaseJudgeResults: compileError ? {} : { custom: {
          stdout: result.program_output || "", stderr: result.program_error || "",
          exitcode: result.signal ? null : Number(result.status),
          exceed: /(?:cpu )?time limit/i.test(result.signal || "") ? "TIME_LIMIT_EXCEEDED" : "UNKNOWN_TESTCASE_EXCEED",
        } },
      },
    }]
  }).catch(error => {
    const networkFailure = ["TimeoutError", "AbortError", "TypeError", "SyntaxError"].includes(error.name)
    runs.get(submissionId).error = networkFailure ? new Error("连接在线评测服务失败，请稍后重试") : error
  })
  return { submissionId }
}

export async function api(method, url, body) {
  const path = url.split("?", 1)[0]
  if (path === bankRoutes + "/exams") {
    const { name } = await loadBank()
    return { problemSet: { name, problemSetConfig: { compilers: ["JAVAC"] } } }
  }
  if (path === bankRoutes + "/exam-problem-list") {
    const problems = (await questions()).map(summary)
    return { total: problems.length, problems }
  }
  if (path === bankRoutes + "/import-problems" && method === "POST") {
    const all = await questions()
    const state = read("questions", { added: [], deleted: [] })
    const ids = new Set(all.map(problem => problem.id))
    const added = body.items.map((item, index) => {
      try {
        const problem = importedQuestion(item)
        if (ids.has(problem.id)) throw new Error("题目 ID 已存在")
        ids.add(problem.id)
        return problem
      } catch (error) { throw new Error(`第 ${index + 1} 题：${error.message}`) }
    })
    const restoredIds = new Set(added.map(problem => problem.id))
    const originalIds = new Set((await loadBank()).problems.map(problem => problem.id))
    if (added.some(problem => originalIds.has(problem.id))) throw new Error("无法覆盖网站内置题目")
    state.deleted = state.deleted.filter(id => !restoredIds.has(id))
    state.added.push(...added)
    write("questions", state)
    return { imported: added.length, total: all.length + added.length }
  }
  if (path.startsWith(bankRoutes + "/exam-problems/")) {
    const id = path.split("/").at(-1)
    const all = await questions()
    const problem = all.find(item => item.id === id)
    if (!problem) throw Object.assign(new Error("题目不存在"), { status: 404 })
    if (method === "DELETE") {
      const state = read("questions", { added: [], deleted: [] })
      const added = state.added.filter(item => item.id !== id)
      if (added.length === state.added.length) state.deleted.push(id)
      write("questions", { ...state, added })
      return {}
    }
    const siblings = all.filter(item => item.type === problem.type)
    const index = siblings.indexOf(problem)
    return {
      examLabel: problem.label, problemSetProblem: problem,
      previousProblemId: siblings[index - 1]?.id, nextProblemId: siblings[index + 1]?.id,
    }
  }
  if (path.endsWith("/exam-draft")) {
    const key = "draft:" + path.split("/").at(-2)
    if (method === "GET") return { answer: read(key, {}) }
    write(key, body.answer)
    return {}
  }
  if (path.startsWith("/api/user-storage/names/")) {
    const name = path.split("/").at(-1)
    if (method === "GET") return { items: [{ name, value: read(name, "") }] }
    write(name, body.value)
    return {}
  }
  if (path === examRoutes + "/exam-submissions" && method === "POST") return startRun(body.details[0])
  if (path.startsWith(examRoutes + "/submissions/") && method === "GET") {
    const id = path.split("/").at(-1)
    const run = runs.get(id)
    if (!run) throw new Error("评测记录不存在")
    if (run.error || run.submission.status !== "JUDGING") runs.delete(id)
    if (run.error) throw run.error
    return { submission: run.submission }
  }
  if (path === examRoutes + bankRoutes.slice(4) + "/submissions") return { submissions: [], problemById: {} }
  if (path === bankRoutes + "/common-rankings") return { commonRankings: [], userById: {} }
  throw new Error("此操作在公开刷题版尚不可用")
}
