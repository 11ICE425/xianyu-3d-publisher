# 把项目上传到 GitHub：完整教程（Windows）

> 以本项目 `拓咸助手` 为例，从零到推送成功。
> 现有仓库：<https://github.com/11ICE425/xianyu-3d-publisher>（公开，MIT）
>
> 如果你只是想更新这个仓库的代码，直接看第 7 节；如果是第一次上传自己的项目，从第 1 节开始。

---

## 0. 先搞清三件事

1. **GitHub 账号**：没有就先去 <https://github.com> 注册（免费）。
2. **本地 Git**：用来生成提交、推送到 GitHub。
3. **认证方式**：GitHub 不再接受“账号密码”推送，必须用浏览器授权、SSH 密钥或 Token。
   第一次推送时通常会自动弹浏览器，授权一次以后就记住。

另外，上传前**必须**想清楚哪些文件不能传：

| 不要上传 | 原因 |
| --- | --- |
| 3D 模型文件（`.stl` / `.3mf` / `.obj` / `.skp` / `.blend`） | 体积大（本项目模型约 260MB），且多为第三方版权作品 |
| 采集到的图片、页面截图、页面正文 | 含他人作品与作者信息，公开仓库会构成再分发 |
| API Key / Token / `.env` / 密码文件 | 泄露后会被盗刷，且很难彻底删除 |
| 备份 zip、打包产物（`*.zip`、`_备份_*`） | 体积大且重复 |
| `__pycache__`、`.venv` | 本机环境产物，没有意义 |
| 个人隐私（真实姓名、手机号、地址、订单） | 公开仓库人人可见 |

本项目就是按这个原则写的 [`.gitignore`](.gitignore)，可以直接参考。

---

## 1. 安装并配置 Git

### 1.1 安装

Windows 最省事的方式是用 winget：

```powershell
winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
```

装完**重新打开一个终端**，确认：

```powershell
git --version
```

> 也可以从 <https://git-scm.com/download/win> 下载安装包，一路默认即可。

### 1.2 配置提交身份

这里配置的名字/邮箱会写进每一次 commit，**不要乱填**：

```powershell
git config --global user.name "你的GitHub用户名"
git config --global user.email "你的GitHub邮箱"
```

推荐用 GitHub 提供的隐私邮箱（在 GitHub 的 Settings → Emails 里可以看到）：

```text
12345678+你的用户名@users.noreply.github.com
```

这样公开仓库里不会暴露你的真实邮箱。本项目用的就是：

```powershell
git config user.name "11ICE425"
git config user.email "11ICE425@users.noreply.github.com"
```

> `--global` 是全局默认；只想对当前仓库生效就去掉 `--global`，在仓库目录里执行。

---

## 2. 选择登录方式（三选一）

### 方式 A：浏览器授权（推荐，最省事）

新版本 Git 自带 **Git Credential Manager（GCM）**。第一次对 GitHub 执行 `push` 时，
它会自动打开浏览器，你登录并点 **Authorize**，凭据会存进 Windows 凭据管理器。

也可以主动登录：

```powershell
git credential-manager github login --web
```

浏览器会打开 GitHub 的授权页，确认账号后点绿色 **Authorize**。
之后 `git push` 就不会再问密码。

> 如果终端提示找不到 `git-credential-manager`，它的完整路径通常是：
> `C:\Program Files\Git\mingw64\bin\git-credential-manager.exe`

### 方式 B：GitHub CLI（适合以后常用）

```powershell
winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
```

重新打开终端后：

```powershell
gh auth login --hostname github.com --git-protocol https --web
```

在浏览器里完成授权。之后还可以直接用 `gh repo create` 建仓库、`gh run list` 看 CI。

### 方式 C：SSH 密钥（不想用浏览器弹窗）

```powershell
ssh-keygen -t ed25519 -C "你的GitHub邮箱"
# 一路回车，密钥默认在 C:\Users\你\.ssh\id_ed25519

# 复制公钥内容
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

打开 GitHub → 右上角头像 → Settings → **SSH and GPG keys** → New SSH key → 粘贴 → 保存。

验证：

```powershell
ssh -T git@github.com
# 显示 Hi 用户名! You've successfully authenticated... 即成功
```

之后远程地址用 SSH 形式：`git@github.com:用户名/仓库名.git`。

### 方式 D：Personal Access Token（PAT，应急用）

GitHub → Settings → Developer settings → **Personal access tokens** → Fine-grained tokens →
新建一个只授权给目标仓库的 token，权限勾选 **Contents: Read and write**（要传 workflow 文件还需 Workflows 权限）。

推送时用户名填 GitHub 用户名，密码位置粘贴 token。**不要把 token 写进代码或文档。**

---

## 3. 在 GitHub 创建仓库

网页方式：

1. 打开 <https://github.com/new>
2. Repository name 填仓库名，例如 `xianyu-3d-publisher`
3. 选择 **Public**（开源，所有人可见）或 **Private**（仅自己可见）
4. **不要**勾选 “Add a README file / .gitignore / license”——本地已经有了，勾了反而要处理冲突
5. 点 **Create repository**

命令行方式（可选，需要先完成第 2 节的方式 A 或 B）：

```powershell
# 在当前项目目录里建私有仓库并推送
gh repo create xianyu-3d-publisher --private --source . --remote origin --push

# 建公开仓库就把 --private 换成 --public
```

---

## 4. 本地整理：上传前最重要的一步

### 4.1 写 `.gitignore`

在项目根目录建 `.gitignore`，把不该传的东西排除掉。本项目的内容：

```gitignore
# 3D 模型文件
*.stl
*.3mf
*.obj
*.step
*.stp
*.gcode
*.blend
*.skp
拓咸助手/拓竹3D打印/

# 采集到的图片、截图、页面正文
信息储存/
**/信息储存/
**/screenshot_visible.png
**/images/
**/data/collected/
**/data/processed/

# 备份与打包
_备份_*/
*.zip

# Python 缓存
__pycache__/
*.py[cod]
.venv/

# 密钥与本地配置
.env
.env.*
*.local.json

# 临时登录文件
_gh_login/
```

> 已经被 `git add` 的文件，再加 `.gitignore` 不会自动移除，需要：
> `git rm -r --cached 路径`（只从 Git 移除，磁盘文件保留）。

### 4.2 检查有没有密钥

PowerShell 可以直接扫：

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.json,*.py,*.md,*.txt,*.ps1 |
  Select-String -Pattern 'sk-[A-Za-z0-9]{10,}|api[_-]?key\s*[:=]\s*["''][A-Za-z0-9]{10,}'
```

有命中就先删掉/改成占位符，**不要先提交再删**——提交历史里仍然能翻出来。

### 4.3 初始化并提交

```powershell
cd "你的项目目录"

git init -b main
git add -A

# 提交前一定要看一眼：有没有大文件、隐私文件、模型、图片
git status --short
git diff --cached --stat

git commit -m "feat: 项目初始版本"
```

几个常用检查：

```powershell
# 看暂存区里最大的文件（PowerShell）
git ls-files | ForEach-Object { Get-Item $_ } |
  Sort-Object Length -Descending | Select-Object -First 10 Name, Length

# 看仓库对象体积
git count-objects -vH
```

如果发现大文件被暂存：

```powershell
git rm --cached "大文件路径"
# 补进 .gitignore，再重新 commit
```

> GitHub 单文件硬限制 100MB，超过会被拒绝；仓库建议控制在 1GB 以内。

---

## 5. 关联远程仓库并推送

```powershell
# 把 <用户名> <仓库名> 换成你自己的
git remote add origin https://github.com/<用户名>/<仓库名>.git

# 如果之前加错过：
# git remote set-url origin https://github.com/<用户名>/<仓库名>.git

git push -u origin main
```

第一次推送会触发认证：

- 方式 A：自动弹浏览器 → 登录 → **Authorize**
- 方式 B：之前 `gh auth login` 已完成，直接推
- 方式 C：SSH 地址不需要额外认证
- 方式 D：用户名 + token

看到下面这类输出就成功了：

```text
To https://github.com/11ICE425/xianyu-3d-publisher.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

---

## 6. 验证上传结果

```powershell
git ls-remote --heads origin   # 能看到 refs/heads/main 和 commit 号
git status -sb                 # 显示 ## main...origin/main 且没有未提交改动
```

网页打开 `https://github.com/<用户名>/<仓库名>`：

- 能看到 README 渲染出来的说明
- 文件列表里没有模型/图片/备份
- 仓库顶部显示 `Public`（如果选了开源）
- 点 **Actions** 能看到 CI 跑过（如果仓库带了 `.github/workflows`）

本项目推送后的实际结果：

- 仓库：<https://github.com/11ICE425/xianyu-3d-publisher>
- 首次提交：`feat: 拓咸助手 · MakerWorld → 闲鱼 3D 打印半自动发布系统`
- CI：`ci` workflow 通过（Node 采集/发布助手测试 + Python 管线测试）

---

## 7. 以后怎么更新代码

日常只需要三条命令：

```powershell
git add -A
git commit -m "fix: 修了 xxx"
git push
```

建议习惯：

```powershell
# 动手前先拉取远端最新
git pull --rebase

# 看当前改了哪些文件
git status
git diff
```

> 注意：本项目里有两份采集扩展代码（根目录的 `3D模型一键采集扩展/` 和
> `拓咸助手/.../采集扩展/`），改完记得同步两份，否则仓库里会不一致。

### 如果需要多人协作

```powershell
git checkout -b feature/xxx     # 新建分支
git add -A && git commit -m "feat: xxx"
git push -u origin feature/xxx  # 推送分支
```

然后在 GitHub 网页上发 Pull Request，审核后合并到 `main`。

---

## 8. 常见问题与排查

### 8.1 `Failed to connect to github.com port 443` / 超时

- 先确认能打开 <https://github.com>
- 公司网络/校园网可能需要代理：

```powershell
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890
# 取消代理
git config --global --unset http.proxy
git config --global --unset https.proxy
```

### 8.2 `Authentication failed` / 反复弹登录

```powershell
# 清掉旧凭据后重新授权
git credential-manager github logout
git credential-manager github login --web
```

也可以在 Windows「凭据管理器 → Windows 凭据」里删除 `git:https://github.com`。

### 8.3 提交作者不对 / 邮箱暴露了

如果还没推送，直接改最近一次提交：

```powershell
git config user.name "正确名字"
git config user.email "正确邮箱"
git commit --amend --reset-author --no-edit
```

如果已经推送，且要改历史作者（谨慎，会改写提交号）：

```powershell
git rebase --root --exec "git commit --amend --reset-author --no-edit"
git push --force-with-lease
```

### 8.4 中文文件名显示成 `\346\250\241...`

```powershell
git config --global core.quotepath false
```

### 8.5 `LF will be replaced by CRLF` 警告

只是换行提示，不影响使用。想统一可以在仓库加 `.gitattributes`：

```gitattributes
* text=auto eol=lf
*.bat text eol=crlf
*.ps1 text eol=crlf
```

### 8.6 私有仓库改公开

网页：仓库 → **Settings** → 最下面 **Danger Zone** → **Change visibility** → Change to public。
命令行（需要 `gh`）：

```powershell
gh repo edit --visibility public --accept-visibility-change-consequences
```

### 8.7 传了不该传的文件（密钥/大文件）

- 只是本地暂存：`git rm --cached 文件` + 加 `.gitignore`
- 已经 push：需要从历史里清除（`git filter-repo`），并**立刻作废相关 Key/Token**
- 大文件已经 push：改用 Git LFS，或清理历史后强制推送

### 8.8 想删除仓库

Settings → Danger Zone → Delete this repository（需要输入仓库名确认）。

---

## 9. 开源前检查清单

- [ ] `.gitignore` 已排除模型、图片、备份、缓存、密钥
- [ ] `git log -p` / `git diff --cached` 没看到敏感信息
- [ ] README 说清楚了：项目做什么、怎么装、怎么用、有什么限制
- [ ] 有 `LICENSE`（本项目用 MIT）
- [ ] 说明了第三方内容的版权（模型/图片归原作者，商用需授权）
- [ ] 没有把 DeepSeek Key、GitHub Token 写进任何文件
- [ ] 仓库默认分支是 `main`
- [ ] 如果加了 CI，第一次 push 后确认 Actions 是绿色

---

## 10. 本项目实际用到的命令（可对照）

以下就是本仓库从零上传时执行的步骤（已隐去 token，仅作参考）：

```powershell
# 1) 安装 GitHub CLI（可选，本文最终用了 GCM 浏览器授权）
winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements

# 2) 配置提交身份
git config user.name "11ICE425"
git config user.email "11ICE425@users.noreply.github.com"

# 3) 初始化、检查、提交
git init -b main
git add -A
git status --short          # 确认没有模型/截图/备份
git commit -m "feat: 拓咸助手 · MakerWorld → 闲鱼 3D 打印半自动发布系统"

# 4) 首次认证（GCM 会打开浏览器，点 Authorize）
git credential-manager github login --web

# 5) 关联远程并推送
git remote add origin https://github.com/11ICE425/xianyu-3d-publisher.git
git push -u origin main

# 6) 验证
git ls-remote --heads origin
```

创建仓库也可以用 API 或网页，本项目是通过 GitHub API 创建私有仓库后再改公开的；
日常最简单的还是网页 <https://github.com/new> 或 `gh repo create`。
