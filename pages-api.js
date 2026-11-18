const examRoutes = "/api/exams/2121142069793841152"
const bankRoutes = "/api/problem-sets/2121133349609480192"
const storagePrefix = "pta-pages:"
const compareLabels = new Intl.Collator("zh-CN", { numeric: true })
const runs = new Map()
let bankRequest

function javaCompilerLog(entries = []) {
  const output = []
  const hidden = { error: 0, warning: 0 }
  let launcherDiagnostic = false
  for (const { text, tag } of entries) {
    const total = /^(\d+) (error|warning)s?$/.exec(text)
    if (total) {
      const kind = total[2]
      const count = Number(total[1]) - hidden[kind]
      if (count > 0) output.push(`${count} ${kind}${count === 1 ? "" : "s"}`)
      continue
    }
    const diagnostic = /^(.*?):\d+(?::\d+)?: (error|warning):/.exec(text)
    if (diagnostic) {
      launcherDiagnostic = tag?.file === "example.java" ||
        ["<source>", "example.java", "./example.java"].includes(diagnostic[1])
      if (launcherDiagnostic) hidden[diagnostic[2]] += 1
    } else if (/^(?:error|warning|Note):/.test(text)) {
      launcherDiagnostic = false
    }
    if (!launcherDiagnostic) {
      output.push(text.replace(/^\.\/Main\.java(?=:\d+:)/, "Main.java"))
    }
  }
  if (!output.length && hidden.error) return "请在 Main.java 中定义 Main 类和 public static void main(String[] args)。"
  return output.join("\n")
}

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

function summary({ id, label, title, type, score, sampleOnly, chapter, content, blocks }) {
  const searchable = blocks?.map(block => block.text || block.alt || "").join(" ") || content || ""
  return { id, label, title, type, score, sampleOnly, chapter, searchable }
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

  void fetch("https://godbolt.org/api/compiler/java2102/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      // Compiler Explorer calls its primary file example.java. Compile the
      // user's program separately so public class Main stays in Main.java.
      source: "class PtaPracticeEntry { public static void main(String[] args) throws Throwable { Main.main(args); } }",
      files: [{ filename: "Main.java", contents: program }],
      options: {
        userArguments: "Main.java",
        executeParameters: {
          stdin,
          // Java's console streams follow the process locale, even when its
          // default charset and source-file encoding are already UTF-8.
          runtimeTools: [{
            name: "env",
            options: [
              { name: "LANG", value: "C.UTF-8" },
              { name: "LC_ALL", value: "C.UTF-8" },
            ],
          }],
        },
        filters: { execute: true },
      },
    }),
    signal: AbortSignal.timeout(45000),
  }).then(async response => {
    if (response.status === 429) throw new Error("评测请求过多，请稍后重试")
    if (!response.ok) throw new Error("在线评测服务暂不可用")
    const result = await response.json()
    if (!Number.isInteger(result.code) || result.code < 0) {
      throw new Error("在线评测服务未返回有效结果，请稍后重试")
    }
    const run = result.execResult
    const build = run?.buildResult || result
    const compileError = build.code !== 0
    const lines = entries => (entries || []).map(entry => entry.text).join("\n")
    if (!compileError && !run?.didExecute) throw new Error("在线评测服务未执行代码，请稍后重试")
    if (run?.truncated) throw new Error("程序输出超过评测服务限制")
    submission.status = compileError ? "COMPILE_ERROR" : "NEUTRAL"
    submission.judgeAt = new Date().toISOString()
    submission.judgeResponseContents = [{
      status: submission.status,
      programmingJudgeResponseContent: {
        compilationResult: { success: !compileError, log: javaCompilerLog(build.stderr) },
        testcaseJudgeResults: compileError ? {} : { custom: {
          stdout: lines(run.stdout), stderr: lines(run.stderr),
          exitcode: Number.isInteger(run.code) ? run.code : null,
          time: typeof run.execTime === "number" ? run.execTime / 1000 : undefined,
          exceed: run.timedOut ? "TIME_LIMIT_EXCEEDED" : "UNKNOWN_TESTCASE_EXCEED",
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
