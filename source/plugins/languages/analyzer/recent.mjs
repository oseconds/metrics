//Imports
import linguist from "linguist-js"
import { filters } from "../../../app/metrics/utils.mjs"
import { Analyzer } from "./analyzer.mjs"


console.log("CUSTOM RECENT FIX")
/**Recent analyzer */
export class RecentAnalyzer extends Analyzer {
  /**Constructor */
  constructor() {
    super(...arguments)
    this.days = arguments[1]?.days ?? 0
    this.load = arguments[1]?.load ?? 0
    Object.assign(this.results, {days: this.days})
  }

  /**Run analyzer */
  run() {
    return super.run(async () => {
      await this.analyze("/dev/null")
    })
  }

  /**Analyze a repository */
  async analyze(path) {
    const patches = await this.patches()
    return super.analyze(path, {commits: patches})
  }

  /**Fetch patches */
  async patches() {
  // Fetch commits from recent activity
  this.debug(`fetching patches from last ${this.days || ""} days up to ${this.load || "∞"} events`)

  const cutoff = this.days
    ? new Date(Date.now() - this.days * 24 * 60 * 60 * 1000)
    : null

  const repositories = new Map()

  // Repository mode: analyze the selected repository directly
  if (this.context.mode === "repository") {
    try {
      const {data: {default_branch: branch}} = await this.rest.repos.get(this.context)
      this.context.branch = branch
      this.results.branch = branch
      repositories.set(`${this.context.owner}/${this.context.repo}`, {
        owner: this.context.owner,
        repo: this.context.repo,
      })
      this.debug(`default branch for ${this.context.owner}/${this.context.repo} is ${branch}`)
    }
    catch (error) {
      this.debug(`failed to get default branch for ${this.context.owner}/${this.context.repo} (${error})`)
    }
  }
  else {
    // Global mode: use recent PushEvents only to discover repositories.
    // Do not rely on payload.commits because GitHub may omit it.
    const events = []
    const pages = Math.ceil((this.load || 500) / 100)

    try {
      for (let page = 1; page <= pages; page++) {
        this.debug(`fetching events page ${page}`)

        const loaded = (
          await this.rest.activity.listEventsForAuthenticatedUser({
            username: this.login,
            per_page: 100,
            page,
          })
        ).data

        if (!loaded.length)
          break

        events.push(
          ...loaded.filter(({type, created_at, repo}) =>
            type === "PushEvent" &&
            repo?.name &&
            (!cutoff || new Date(created_at) > cutoff)
          )
        )
      }
    }
    catch {
      this.debug("no more page to load")
    }

    for (const {repo: {name}} of events) {
      const [owner, repo] = name.split("/")
      if (owner && repo && !this.ignore(name))
        repositories.set(name, {owner, repo})
    }

    this.debug(`found ${repositories.size} repositories from recent push events`)
  }

  // Load commits directly from repositories.
  // This replaces PushEvent.payload.commits.
  const commits = []

  for (const repository of repositories.values()) {
    try {
      for (let page = 1;; page++) {
        const {data: loaded} = await this.rest.repos.listCommits({
          ...repository,
          author: this.login,
          per_page: 100,
          page,
        })

        if (!loaded.length)
          break

        for (const commit of loaded) {
          const date =
            commit?.commit?.author?.date ||
            commit?.commit?.committer?.date

          if (cutoff && date && new Date(date) <= cutoff)
            break

          if (commit?.url)
            commits.push(commit)

          if (this.load && commits.length >= this.load)
            break
        }

        if (
          loaded.length < 100 ||
          (this.load && commits.length >= this.load) ||
          (cutoff && loaded.some(commit => {
            const date = commit?.commit?.author?.date || commit?.commit?.committer?.date
            return date && new Date(date) <= cutoff
          }))
        )
          break
      }
    }
    catch (error) {
      this.debug(`failed to fetch commits from ${repository.owner}/${repository.repo} (${error})`)
    }

    if (this.load && commits.length >= this.load)
      break
  }

  // Remove duplicate commits
  const unique = [
    ...new Map(commits.map(commit => [commit.sha, commit])).values()
  ]

  // Newest first
  unique.sort((a, b) => {
    const ad = new Date(a?.commit?.author?.date || a?.commit?.committer?.date || 0)
    const bd = new Date(b?.commit?.author?.date || b?.commit?.committer?.date || 0)
    return bd - ad
  })

  const selected = this.load
    ? unique.slice(0, this.load)
    : unique

  this.debug(`fetched ${selected.length} authored commits`)

  this.results.latest = Math.round(
    (Date.now() - new Date(
      selected[0]?.commit?.author?.date ||
      selected[0]?.commit?.committer?.date
    ).getTime()) / (1000 * 60 * 60 * 24)
  )

  this.results.commits = selected.length

  // Retrieve edited files and patches from individual commit API.
  this.debug("fetching patches")

  const responses = await Promise.allSettled(
    selected.map(commit =>
      this.rest.request(commit.url).then(response => response.data)
    )
  )

  const fulfilled = responses.filter(({status}) => status === "fulfilled")
  const rejected = responses.filter(({status}) => status === "rejected")

  this.debug(`commit API requests = ${responses.length}`)
  this.debug(`fulfilled = ${fulfilled.length}`)
  this.debug(`rejected = ${rejected.length}`)

  if (rejected.length)
    this.debug(`first API error = ${rejected[0].reason}`)

  const patches = fulfilled
    .map(({value}) => value)
    .filter(({parents}) => (parents?.length ?? 0) <= 1)
    .map(({sha, commit: {message, committer}, verification, files = []}) => ({
      sha,
      name: `${message} (authored by ${committer.name} on ${committer.date})`,
      verified: verification?.verified ?? null,
      editions: files.map(({filename, patch = ""}) => {
        const edition = {
          path: filename,
          added: {lines: 0, bytes: 0},
          deleted: {lines: 0, bytes: 0},
          patch,
        }

        for (const line of patch.split("\n")) {
          if ((!/^[-+]/.test(line)) || (!line.trim().length))
            continue

          if (this.markers.line.test(line)) {
            const {op = "+", content = ""} =
              line.match(this.markers.line)?.groups ?? {}

            const size = Buffer.byteLength(content, "utf-8")

            edition[{"+": "added", "-": "deleted"}[op]].bytes += size
            edition[{"+": "added", "-": "deleted"}[op]].lines++
          }
        }

        return edition
      }),
    }))

  this.debug(`received ${patches.length} commit details`)

  return patches
}

  

  /**Run linguist against a commit and compute edited lines and bytes*/
  async linguist(_, {commit, cache: {languages}}) {
    const cache = {files: {}, languages}
    const result = {total: 0, files: 0, missed: {lines: 0, bytes: 0}, lines: {}, stats: {}, languages: {}}
    const edited = new Set()
    for (const edition of commit.editions) {
      edited.add(edition.path)

      //Guess file language with linguist
      const {files: {results: files}, languages: {results: languages}, unknown} = await linguist(edition.path, {fileContent: edition.patch})
      Object.assign(cache.files, files)
      Object.assign(cache.languages, languages)
      if (!(edition.path in cache.files))
        cache.files[edition.path] = "<unknown>"

      //Aggregate statistics
      const language = cache.files[edition.path]
      edition.language = language
      const numbers = edition.patch
        .split("\n")
        .filter(line => this.markers.line.test(line))
        .map(line => Buffer.byteLength(line.substring(1).trimStart(), "utf-8"))
      const added = numbers.reduce((a, b) => a + b, 0)
      result.total += added
      if (language === "<unknown>") {
        result.missed.lines += numbers.length
        result.missed.bytes += unknown.bytes
      }
      else {
        result.lines[language] = (result.lines[language] ?? 0) + numbers.length
        result.stats[language] = (result.stats[language] ?? 0) + added
      }
    }
    result.files = edited.size
    result.languages = cache.languages
    return result
  }
}
