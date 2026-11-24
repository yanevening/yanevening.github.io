import { cloudConfig } from "./cloud-config.js?v=20261124"

const configured = Boolean(cloudConfig.url && cloudConfig.publishableKey)
const answerKey = "ptaPracticeAnswers_2121133349609480192"
const cachePrefix = "pta-pages:cloud:"
const recordPattern = /^(answer|draft):[0-9]{1,32}$/
const read = key => {
  try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
}
const $ = id => document.getElementById(id)

let client, account, cache, syncTimer, syncTask
let downloadNeeded = false

function records(prefix) {
  const entries = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) entries.push(key)
  }
  return entries
}

export function signedIn() {
  return Boolean(account)
}

export function readAccountRecords(kind) {
  const prefix = cache + kind + ":"
  return Object.fromEntries(records(prefix).flatMap(key => {
    const entry = read(key)
    return entry ? [[key.slice(prefix.length), entry.payload]] : []
  }))
}

export function readAccountDraft(id) {
  return read(cache + "draft:" + id)?.payload ?? null
}

export function saveAccountRecord(kind, id, payload) {
  const key = cache + kind + ":" + id
  const previous = read(key)
  const editedAt = new Date(Math.max(Date.now(), (Date.parse(previous?.edited_at) || 0) + 1)).toISOString()
  localStorage.setItem(key, JSON.stringify({ payload, edited_at: editedAt, pending: true }))
  status("待同步")
  scheduleSync(750)
}

function status(message) {
  $("cloud-account-status").textContent = message
  $("cloud-account-button").textContent = account ? "账号 · " + message : "登录"
}

function scheduleSync(delay) {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => { void sync() }, delay)
}

async function push() {
  const pending = records(cache).flatMap(key => {
    const serialized = localStorage.getItem(key)
    let entry
    try { entry = JSON.parse(serialized) } catch { return [] }
    return entry?.pending ? [{ key, serialized, entry }] : []
  })
  for (let offset = 0; offset < pending.length; offset += 25) {
    const batch = pending.slice(offset, offset + 25)
    const { error } = await client.rpc("merge_practice_records", {
      expected_user: account.id,
      records: batch.map(({ key, entry }) => ({
        record_key: key.slice(cache.length), payload: entry.payload,
        edited_at: entry.edited_at, import_only: entry.import_only ?? false,
      })),
    })
    if (error) throw error
    for (const { key, serialized, entry } of batch) {
      if (localStorage.getItem(key) === serialized) {
        localStorage.setItem(key, JSON.stringify({ ...entry, pending: false }))
      }
    }
  }
}

async function pull() {
  let cursor = ""
  while (true) {
    const query = client.from("practice_records")
      .select("record_key,payload,edited_at")
      .eq("user_id", account.id).order("record_key").limit(100)
    if (cursor) query.gt("record_key", cursor)
    const { data, error } = await query
    if (error) throw error
    for (const { record_key, payload, edited_at } of data) {
      if (!recordPattern.test(record_key)) continue
      const key = cache + record_key
      const entry = read(key)
      if (!entry?.pending && (!entry || entry.import_only || Date.parse(edited_at) >= Date.parse(entry.edited_at))) {
        localStorage.setItem(key, JSON.stringify({ payload, edited_at }))
      }
    }
    if (data.length < 100) return
    cursor = data.at(-1).record_key
  }
}

async function sync({ download = false } = {}) {
  if (!account) return false
  if (syncTask) return download ? syncTask.then(() => sync({ download: true })) : syncTask
  downloadNeeded ||= download
  clearTimeout(syncTimer)
  status("同步中")
  const task = (async () => {
    try {
      await push()
      if (downloadNeeded) {
        await pull()
        downloadNeeded = false
      }
      const pending = records(cache).some(key => read(key)?.pending)
      status(pending ? "待同步" : "已同步")
      if (pending) scheduleSync(750)
      return true
    } catch {
      status("同步失败")
      scheduleSync(15000)
      return false
    }
  })()
  syncTask = task
  try { return await task }
  finally { if (syncTask === task) syncTask = null }
}

export async function syncAccountDraft() {
  return sync()
}

function guestRecords() {
  const answers = read(answerKey)
  const entries = new Map()
  for (const [id, payload] of Object.entries(answers ?? {})) {
    if (recordPattern.test("answer:" + id) && payload && typeof payload === "object" && !Array.isArray(payload)) {
      entries.set("answer:" + id, payload)
    }
  }
  const draftIds = new Set([
    ...records("codingProblem_").map(key => key.slice("codingProblem_".length)),
    ...records("pta-pages:draft:").map(key => key.slice("pta-pages:draft:".length)),
  ])
  for (const id of draftIds) {
    if (!recordPattern.test("draft:" + id)) continue
    const cached = read("codingProblem_" + id)
    const saved = read("pta-pages:draft:" + id)
    const detail = saved?.detail
    const program = detail?.programmingSubmissionDetail
    const useSaved = typeof program?.program === "string" &&
      !(Date.parse(cached?.saveAt) > 0 && Date.parse(cached.saveAt) > Date.parse(saved.saveAt))
    const draft = useSaved ? {
      ...program, testData: detail.customTestData?.content,
      customExpected: cached?.customExpected, expectedOutput: cached?.expectedOutput,
    } : cached
    if (typeof draft?.program === "string") entries.set("draft:" + id, draft)
  }
  return entries
}

async function loadClient() {
  if (client) return
  if (!globalThis.supabase) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = "/vendor/supabase-2.119.2.js"
      script.onload = resolve
      script.onerror = reject
      document.head.append(script)
    })
  }
  client = globalThis.supabase.createClient(cloudConfig.url, cloudConfig.publishableKey, {
    auth: { flowType: "pkce" },
    global: {
      fetch: (input, init) => {
        const requestUrl = input instanceof Request ? input.url : input.toString()
        const timeout = AbortSignal.timeout(requestUrl.includes("/auth/v1/") ? 15000 : 8000)
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
        return fetch(input, { ...init, signal })
      },
    },
  })
}

function authMessage(error) {
  switch (error?.code) {
    case "invalid_credentials": return "邮箱或密码有误。"
    case "email_not_confirmed": return "请先到邮箱完成验证。"
    case "weak_password": return "密码强度不足，请换一个更长的密码。"
    case "over_email_send_rate_limit": return "邮件发送太频繁，请稍后重试。"
    case "email_address_not_authorized": return "当前邮件服务无法向这个邮箱发送验证邮件。"
    case "user_already_exists": return "该邮箱已注册，请直接登录。"
    default: return "暂时无法完成操作，请稍后重试。"
  }
}

export async function initCloudAccount() {
  const button = $("cloud-account-button")
  const dialog = $("cloud-account-dialog")
  const form = $("cloud-auth-form")
  const message = $("cloud-account-message")
  const importButton = $("cloud-account-import")
  const savedImport = $("cloud-account-import-note")
  const syncButton = $("cloud-account-sync")
  const logoutButton = $("cloud-account-logout")
  const githubButton = $("cloud-auth-github")
  $("cloud-auth-register").hidden = cloudConfig.emailRegistration !== true
  let importEntries

  const showDialog = () => {
    message.textContent = configured ? "" : "云同步暂未开通。你可以继续在此浏览器刷题。"
    form.hidden = !configured || signedIn()
    $("cloud-auth-note").hidden = form.hidden || cloudConfig.emailRegistration || cloudConfig.githubLogin
    githubButton.hidden = !configured || signedIn() || !cloudConfig.githubLogin
    $("cloud-account-panel").hidden = !signedIn()
    if (account) {
      $("cloud-account-email").textContent = account.email ?? ""
      importEntries = guestRecords()
      importButton.hidden = !importEntries.size
      savedImport.hidden = importButton.hidden
      savedImport.textContent = importEntries.size
        ? `此浏览器有 ${importEntries.size} 条访客记录可导入，账号里已有的记录优先保留。` : ""
    }
    dialog.showModal()
  }
  button.onclick = showDialog
  $("cloud-account-close").onclick = () => dialog.close()
  button.hidden = false
  if (!configured) return

  let busy = false, changingSession = false
  async function act(operation, changesSession = false) {
    if (busy) return
    busy = true
    changingSession = changesSession
    message.textContent = ""
    const buttons = dialog.querySelectorAll("button:not(#cloud-account-close)")
    buttons.forEach(item => { item.disabled = true })
    try { await operation() }
    catch (error) { message.textContent = authMessage(error) }
    finally {
      buttons.forEach(item => { item.disabled = false })
      busy = false
      changingSession = false
    }
  }

  form.onsubmit = event => {
    event.preventDefault()
    const register = cloudConfig.emailRegistration === true && event.submitter?.value === "register"
    const email = $("cloud-auth-email").value.trim()
    const passwordInput = $("cloud-auth-password")
    const password = passwordInput.value
    if (register && password.length < 8) {
      message.textContent = "注册密码至少需要 8 个字符。"
      return
    }
    void act(async () => {
      await loadClient()
      const credentials = { email, password }
      const result = register
        ? await client.auth.signUp({ ...credentials, options: { emailRedirectTo: location.origin + "/" } })
        : await client.auth.signInWithPassword(credentials)
      if (result.error) throw result.error
      passwordInput.value = ""
      if (result.data.session) location.reload()
      else message.textContent = "请在当前浏览器打开验证邮件里的链接，完成注册。"
    }, true)
  }
  githubButton.onclick = () => void act(async () => {
    await loadClient()
    const { error } = await client.auth.signInWithOAuth({
      provider: "github", options: { redirectTo: location.origin + "/" },
    })
    if (error) throw error
  })
  syncButton.onclick = () => void act(async () => {
    if (await sync({ download: true })) location.reload()
    else message.textContent = "云同步失败，本机记录已保留。"
  })
  importButton.onclick = () => void act(async () => {
    for (const [recordKey, payload] of importEntries) {
      const key = cache + recordKey
      if (!read(key)) {
        localStorage.setItem(key, JSON.stringify({
          payload, edited_at: new Date(0).toISOString(), import_only: true, pending: true,
        }))
      }
    }
    if (await sync({ download: true })) location.reload()
    else message.textContent = "导入已保存在本机，连接成功后会继续同步。"
  })
  logoutButton.onclick = () => void act(async () => {
    const { error } = await client.auth.signOut({ scope: "local" })
    if (error) throw error
    location.reload()
  }, true)
  button.disabled = true
  try {
    await loadClient()
    const { data, error } = await client.auth.getSession()
    if (error) throw error
    account = data.session?.user
    if (account) {
      cache = cachePrefix + account.id + ":"
      await sync({ download: true })
    }
    client.auth.onAuthStateChange((event, session) => {
      if (!changingSession && event !== "INITIAL_SESSION" && session?.user?.id !== account?.id) location.reload()
    })
    window.addEventListener("online", () => { void sync() })
    window.addEventListener("pageshow", event => { if (event.persisted) location.reload() })
  } catch {
    status("同步失败")
  } finally {
    button.disabled = false
  }
}
