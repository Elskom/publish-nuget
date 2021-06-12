const os = require("os"),
    fs = require("fs"),
    path = require("path"),
    https = require("https"),
    spawnSync = require("child_process").spawnSync,
    globfs = require("glob-fs")({ gitignore: false }),
    hasGlob = require("has-glob")

const SOURCE_NAME = "nuget.org";

class Package {
    
    constructor(projectFile, versionFile, version, packageName) {
        this.projectFile = projectFile
        this.versionFile = versionFile
        this.version = version
        this.packageName = packageName
    }
}

class Action {

    constructor() {
        this.packagePath = process.env.INPUT_PACKAGE_PATH
        this.projectFile = process.env.INPUT_PROJECT_FILE_PATH
        this.packageName = process.env.INPUT_PACKAGE_NAME || process.env.PACKAGE_NAME
        this.versionFile = process.env.INPUT_VERSION_FILE_PATH || process.env.VERSION_FILE_PATH || this.projectFile
        this.versionRegex = new RegExp(process.env.INPUT_VERSION_REGEX || process.env.VERSION_REGEX, "m")
        this.packableRegex = new RegExp(process.env.INPUT_PACKABLE_REGEX || process.env.PACKABLE_REGEX, "m")
        this.version = process.env.INPUT_VERSION_STATIC || process.env.VERSION_STATIC
        this.tagCommit = JSON.parse(process.env.INPUT_TAG_COMMIT || process.env.TAG_COMMIT)
        this.tagFormat = process.env.INPUT_TAG_FORMAT || process.env.TAG_FORMAT
        this.githubUser = process.env.INPUT_GITHUB_USER || process.env.GITHUB_ACTOR
        this.nugetKey = process.env.INPUT_NUGET_KEY || process.env.NUGET_KEY
        this.nugetSource = process.env.INPUT_NUGET_SOURCE || process.env.NUGET_SOURCE
        this.throwOnVersionExixts = process.env.INPUT_THOW_ERROR_IF_VERSION_EXISTS || process.env.THOW_ERROR_IF_VERSION_EXISTS
        if (this.nugetSource.startsWith(`https://nuget.pkg.github.com/`)) {
            this.sourceType = "GPR"
            this._executeCommand(`dotnet nuget add source ${this.nugetSource}/index.json --name=${(SOURCE_NAME)} --username=${this.githubUser} --password=${this.nugetKey} --store-password-in-clear-text`, { encoding: "utf-8" })
        }

        console.log(this._executeCommand("dotnet nuget list source", { encoding: "utf8" }).stdout)
        console.log(this._executeCommand(`dotnet nuget enable source ${SOURCE_NAME}`, { encoding: "utf8" }).stdout)
        this.packages = []
    }

    _printErrorAndExit(msg) {
        console.log(`##[error]😭 ${msg}`)
        throw new Error(msg)
    }

    _executeCommand(cmd, options) {
        console.log(`executing: [${cmd}]`)

        const INPUT = cmd.split(" "), TOOL = INPUT[0], ARGS = INPUT.slice(1)
        return spawnSync(TOOL, ARGS, options)
    }

    _executeInProcess(cmd) {
        this._executeCommand(cmd, { encoding: "utf-8", stdio: [process.stdin, process.stdout, process.stderr] })
    }

    _tagCommit(version) {
        const TAG = this.tagFormat.replace("*", version)

        console.log(`✨ creating new tag ${TAG}`)

        this._executeInProcess(`git tag ${TAG}`)
        this._executeInProcess(`git push origin ${TAG}`)

        process.stdout.write(`::set-output name=VERSION::${TAG}` + os.EOL)
    }

    _pushPackage(version, name) {
        console.log(`✨ found new version (${version}) of ${name}`)

        if (!this.nugetKey) {
            console.log("##[warning]😢 NUGET_KEY not given")
            return
        }

        console.log(`NuGet Source: ${this.nugetSource}`)

        const pushCmd = `dotnet nuget push ${!this.packagePath.endsWith("/") ? `${this.packagePath}/` : `${this.packagePath}`}${name}.${version}.nupkg -s ${(SOURCE_NAME)} ${this.nugetSource !== "GPR"? `-k ${this.nugetKey}`: ""} --skip-duplicate`

        const pushOutput = this._executeCommand(pushCmd, { encoding: "utf-8" }).stdout

        console.log(pushOutput)

        if (/error/.test(pushOutput))
            this._printErrorAndExit(`${/error.*/.exec(pushOutput)[0]}`)

        if (this.tagCommit)
            this._tagCommit(version)
    }

    _checkForUpdate(_package) {
        if (!_package.packageName) {
            _package.packageName = path.basename(_package.projectFile).split(".").slice(0, -1).join(".")
        }

        console.log(`Package Name: ${_package.packageName}`)

        let url
        let options; //used for authentication

        //small hack to get package versions from Github Package Registry
        if (this.sourceType === "GPR") {
            url = `${this.nugetSource}/download/${_package.packageName}/index.json`
            options = {
                method: "GET",
                auth:`${this.githubUser}:${this.nugetKey}`
            }
            console.log(`This is GPR, changing url for versioning...`)
            console.log(url)
        } else {
            url = `${this.nugetSource}/v3-flatcontainer/${_package.packageName}/index.json`
            options = {
                method: "GET"
            }
        }

        https.get(url, options, (res) => {
            let body = ""

            console.log(`Status code: ${res.statusCode}: ${res.statusMessage}`)

            if (res.statusCode == 404) {
                console.log(`No packages found. Pushing initial version...`)
                this._pushPackage(_package.version, _package.packageName)
            }
            else if (res.statusCode == 200) {
                res.setEncoding("utf8")
                res.on("data", chunk => body += chunk)
                res.on("end", () => {
                    const existingVersions = JSON.parse(body)
                    if (existingVersions.versions.indexOf(_package.version) < 0) {
                        console.log(`This version is new, pushing...`)
                        this._pushPackage(_package.version, _package.packageName)
                    }
                    else
                    {
                        let errorMsg = `Version ${_package.version} already exists`;
                        console.log(errorMsg)

                        if (this.throwOnVersionExixts !== 'false') {
                            this._printErrorAndExit(`error: ${errorMsg}`)
                        }
                    }
                })
            }
            else {
               this._printErrorAndExit(`error: ${res.statusCode}: ${res.statusMessage}`)
            }
        }).on("error", e => {
            this._printErrorAndExit(`error: ${e.message}`)
        })
    }

    _run_internal(_package)
    {
        if (!_package.projectFile || !fs.existsSync(_package.projectFile))
            this._printErrorAndExit("project file not found")

        let projectFileContent = fs.readFileSync(_package.projectFile, { encoding: "utf-8" }),
            parsedTest = this.packableRegex.exec(projectFileContent)

        if (parsedTest == null) {
            if (fs.existsSync(`${path.dirname(_package.projectFile)}/Directory.Build.props`)) {
                let buildProps = fs.readFileSync(`${path.dirname(_package.projectFile)}/Directory.Build.props`, { encoding: "utf-8" })
                parsedTest = this.packableRegex.exec(buildProps)
            }
        }

        if (parsedTest != null && parsedTest[1] === "false") {
            return
        }

        console.log(`Project Filepath: ${_package.projectFile}`)

        if (!_package.version) {
            if (_package.versionFile !== _package.projectFile && !fs.existsSync(_package.versionFile))
                this._printErrorAndExit("version file not found")

            console.log(`Version Filepath: ${_package.versionFile}`)
            console.log(`Version Regex: ${this.versionRegex}`)

            let versionFileContent = fs.readFileSync(_package.versionFile, { encoding: "utf-8" }),
                parsedVersion = this.versionRegex.exec(versionFileContent)

            // fallback to parsing from Directory.Build.props.
            if (!parsedVersion) {
                if (fs.existsSync(`${path.dirname(_package.versionFile)}/Directory.Build.props`)) {
                    versionFileContent = fs.readFileSync(`${path.dirname(_package.versionFile)}/Directory.Build.props`, { encoding: "utf-8" })
                    parsedVersion = this.versionRegex.exec(versionFileContent)
                }
            }

            if (!parsedVersion)
                this._printErrorAndExit("unable to extract version info!")

            _package.version = parsedVersion[1]
            this.packages.push(_package)
        }

        console.log(`Version: ${_package.version}`)

        this.packages.forEach(__package => this._checkForUpdate(__package))
        this.packages.forEach(() => this.packages.pop())
    }

    run() {
        if (!this.packagePath || !fs.existsSync(this.packagePath)) {
            this._printErrorAndExit("PACKAGE_PATH not provided.")
        }

        if (!hasGlob(this.projectFile) && !hasGlob(this.versionFile)) {
            this._run_internal(new Package(this.projectFile, this.versionFile, this.version, this.packageName))
        }

        // it has a glob, now we need to recursively obtain all files
        // represented in the glob and match them up. After that we
        // need to reset the projectFile, and versionFile variables on
        // the object instance each time and call _run_internal() for
        // each file found that matches in the glob.
        globfs.on('include', function (file) {
            const relative = path.relative(process.cwd(), file.path);
            action._run_internal(new Package(relative, relative, null, null))
        })

        globfs.readdirSync(this.projectFile)
    }
}

const action = new Action();
action.run()
