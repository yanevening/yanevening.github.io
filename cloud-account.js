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
let profile
const loginRoute = new URLSearchParams(location.search).get("page") === "login"
const safeText = text => String(text ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char])

async function loadProfile() {
  const { data, error } = await client.from("account_profiles").select("role,enabled")
    .eq("user_id", account.id).single()
  if (error) throw error
  profile = data
  return profile
}

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
      await loadProfile()
      if (!profile.enabled) {
        status("账号已停用")
        return false
      }
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
  if (loginRoute) document.body.classList.add("account-route")
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
      $("cloud-account-title").textContent = "我的学习空间"
      $("cloud-account-role").textContent = profile?.enabled === false ? "账号已停用"
        : profile?.role === "admin" ? "管理员" : profile ? "普通用户" : "权限待确认"
      $("cloud-account-permissions").textContent = profile?.enabled === false
        ? "请联系管理员恢复账号使用权限。"
        : profile?.role === "admin" ? "同步个人记录，并管理站点账号的角色和状态。"
        : "同步自己的答题进度、错题和代码草稿。"
      const active = profile?.enabled === true
      syncButton.hidden = !active
      $("cloud-admin-panel").hidden = !active || profile.role !== "admin"
      $("cloud-account-email").textContent = account.email ?? ""
      importEntries = guestRecords()
      importButton.hidden = !active || !importEntries.size
      savedImport.hidden = importButton.hidden
      savedImport.textContent = importEntries.size
        ? `此浏览器有 ${importEntries.size} 条访客记录可导入，账号里已有的记录优先保留。` : ""
    }
    dialog.showModal()
    if (account && profile?.enabled && profile.role === "admin") void refreshAccounts()
  }
  button.onclick = () => {
    if (!signedIn()) {
      const back = new URLSearchParams({ page: "login", next: location.pathname + location.search })
      location.href = "/?" + back
    } else showDialog()
  }
  $("cloud-account-close").onclick = () => loginRoute ? location.assign("/") : dialog.close()
  dialog.addEventListener("cancel", event => {
    if (loginRoute) { event.preventDefault(); location.href = "/" }
  })
  $("cloud-password-toggle").onclick = () => {
    const input = $("cloud-auth-password")
    const show = input.type === "password"
    input.type = show ? "text" : "password"
    $("cloud-password-toggle").textContent = show ? "隐藏" : "显示"
    $("cloud-password-toggle").setAttribute("aria-label", show ? "隐藏密码" : "显示密码")
    $("cloud-password-toggle").setAttribute("aria-pressed", String(show))
  }
  button.hidden = false
  if (!configured) { if (loginRoute) showDialog(); return }

  let busy = false, changingSession = false
  async function act(operation, changesSession = false) {
    if (busy) return
    busy = true
    changingSession = changesSession
    message.textContent = ""
    form.setAttribute("aria-busy", "true")
    $("cloud-login-submit").textContent = "正在处理…"
    const buttons = dialog.querySelectorAll("button:not(#cloud-account-close)")
    buttons.forEach(item => { item.disabled = true })
    try { await operation() }
    catch (error) { message.textContent = authMessage(error) }
    finally {
      buttons.forEach(item => { item.disabled = false })
      busy = false
      changingSession = false
      form.setAttribute("aria-busy", "false")
      $("cloud-login-submit").textContent = "登录并继续"
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
      if (result.data.session) {
        account = result.data.session.user
        cache = cachePrefix + account.id + ":"
        await loadProfile()
        if (!profile.enabled) {
          showDialog()
          return
        }
        const next = new URLSearchParams(location.search).get("next")
        const destination = next?.startsWith("/") ? new URL(next, location.origin) : null
        location.assign(destination?.origin === location.origin && destination.searchParams.get("page") !== "login"
          ? destination.href : "/")
      }
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
    location.assign("/?page=login")
  }, true)

  async function refreshAccounts() {
    const target = $("cloud-admin-users")
    const feedback = $("cloud-admin-message")
    feedback.textContent = "正在加载账号…"
    try {
      const { data, error } = await client.rpc("list_practice_accounts")
      if (error) throw error
      target.innerHTML = data.map(user => {
        const own = user.user_id === account.id
        return `<form class="account-user" data-user="${safeText(user.user_id)}">
          <strong>${safeText(user.email)}${own ? " · 当前账号" : ""}</strong>
          <div class="account-user-controls"><select name="role" aria-label="账号角色" ${own ? "disabled" : ""}>
          <option value="student" ${user.role === "student" ? "selected" : ""}>普通用户</option>
          <option value="admin" ${user.role === "admin" ? "selected" : ""}>管理员</option></select>
          <label><input type="checkbox" name="enabled" ${user.enabled ? "checked" : ""} ${own ? "disabled" : ""}>启用</label>
          <button class="btn" type="submit" ${own ? "disabled" : ""}>保存</button></div></form>`
      }).join("")
      feedback.textContent = `共 ${data.length} 个账号`
    } catch {
      target.replaceChildren()
      feedback.textContent = "账号列表加载失败，请确认管理员权限并重试。"
    }
  }
  $("cloud-admin-refresh").onclick = refreshAccounts
  $("cloud-admin-users").onsubmit = async event => {
    event.preventDefault()
    const row = event.target
    const save = row.querySelector("button")
    save.disabled = true
    try {
      const { error } = await client.rpc("set_practice_account", {
        target_user: row.dataset.user, new_role: row.elements.role.value,
        new_enabled: row.elements.enabled.checked,
      })
      if (error) throw error
      await refreshAccounts()
      $("cloud-admin-message").textContent = "权限已保存。"
    } catch {
      $("cloud-admin-message").textContent = "保存失败，请确认权限和网络后重试。"
      save.disabled = false
    }
  }
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
    if (loginRoute) showDialog()
  }
}
