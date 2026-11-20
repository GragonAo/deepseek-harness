{{/*
名称与标签。

资源名不跟随 release 名 —— dsh-tenant 被 hermes-jeecg-ai 按固定 DNS 引用，
dsh-tenant-host 是 Service 的 selector 值，Deployment.spec.selector 不可变。
所以这里只提供标签与镜像拼装，不提供 fullname / nameOverride。
*/}}

{{/* Chart 名（供 app.kubernetes.io/name 用）*/}}
{{- define "dsh.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
标准标签。
用法：{{ include "dsh.labels" (dict "root" . "component" .Values.names.tenantHost) }}

`app: <component>` 是 selector 用的键，不可改；app.kubernetes.io/* 与 helm.sh/chart 是
通用规范要求的标签。
*/}}
{{- define "dsh.labels" -}}
{{- $root := .root -}}
{{- $component := .component -}}
app: {{ $component }}
app.kubernetes.io/name: {{ include "dsh.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/version: {{ default $root.Chart.AppVersion $root.Values.releaseVersion | quote }}
app.kubernetes.io/part-of: {{ include "dsh.name" $root }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
app.kubernetes.io/component: {{ $component }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{/* 只用 selector 的那一套标签（必须与历史 Deployment / Service 完全一致）*/}}
{{- define "dsh.selectorLabels" -}}
app: {{ .component }}
{{- end -}}

{{/*
镜像引用。
用法：{{ include "dsh.image" (dict "root" . "repo" .Values.image.tenant "tag" .Values.image.tenantTag) }}
tag 省略时跟随 image.tag，再为空则用 Chart.appVersion。
*/}}
{{- define "dsh.image" -}}
{{- $tag := .tag | default (default .root.Chart.AppVersion .root.Values.image.tag) -}}
{{- printf "%s:%s" .repo $tag -}}
{{- end -}}

{{/*
租户配置正文。

files/tenant-config.yaml 里用 `{{ .Values.* }}` 引值，所以必须过 tpl；
正文本身不含其它 `{{`，tpl 不会吃掉 YAML 内容（曾核对：原文仅 9 个 __TOKEN__ 占位符，
已全部改写为 values 引用）。
*/}}
{{- define "dsh.tenantConfigBody" -}}
{{- tpl (.Files.Get "files/tenant-config.yaml") . -}}
{{- end -}}

{{/*
租户配置卷的来源。

默认 configMap 是刻意保留的默认值，volumeKind=secret 才是设计意图。
见 values.yaml 的注释与 README。
*/}}
{{- define "dsh.tenantConfigVolumeSource" -}}
{{- if eq .Values.config.tenantConfig.volumeKind "secret" -}}
secret:
  secretName: {{ .Values.secrets.tenantConfig.existingSecret }}
  defaultMode: 420
{{- else -}}
configMap:
  name: {{ .Values.secrets.tenantConfig.existingSecret }}
  defaultMode: 420
{{- end -}}
{{- end -}}

{{/*
必填项清单。

刻意不 fail：helm-standard.md §三-1 要求「不带任何 -f 也能渲染成功」，否则 helm lint 与 CI
没法在无凭据环境里跑。缺项由 NOTES.txt 在装完后点名，validation.failOnMissing 置 true 时
改成渲染期硬失败（生产流水线建议开）。
*/}}
{{- define "dsh.missingRequired" -}}
{{- $missing := list -}}
{{- if not .Values.middleware.database.password -}}
{{- $missing = append $missing "middleware.database.password（PG 密码，站点 env 的 DSH_PG_PASSWORD）" -}}
{{- end -}}
{{- if not .Values.dependencies.dshPublicBaseUrl -}}
{{- $missing = append $missing "dependencies.dshPublicBaseUrl（浏览器可达的宿主地址，形如 http://<SITE_HOST>:<NP_TENANT>）" -}}
{{- end -}}
{{- if not .Values.config.cephRgwEndpoint -}}
{{- $missing = append $missing "config.cephRgwEndpoint（对象存储端点；留空则上传与下载链接都不可用）" -}}
{{- end -}}
{{- if .Values.validation.failOnMissing -}}
{{- if $missing -}}
{{- fail (printf "以下必填项为空，拒绝渲染：%s" (join "、" $missing)) -}}
{{- end -}}
{{- end -}}
{{- join "、" $missing -}}
{{- end -}}
