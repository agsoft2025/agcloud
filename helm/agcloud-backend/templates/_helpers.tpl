{{/*
Expand the name of the chart.
*/}}
{{- define "agcloud-backend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agcloud-backend.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "agcloud-backend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agcloud-backend.labels" -}}
helm.sh/chart: {{ include "agcloud-backend.chart" . }}
{{ include "agcloud-backend.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agcloud-backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agcloud-backend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the ServiceAccount to use.
*/}}
{{- define "agcloud-backend.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agcloud-backend.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret to use — either the one this chart creates, or an
externally-managed one (see values.yaml's secretRef / SECRETS WARNING).
*/}}
{{- define "agcloud-backend.secretName" -}}
{{- if .Values.secretRef }}
{{- .Values.secretRef }}
{{- else }}
{{- include "agcloud-backend.fullname" . }}
{{- end }}
{{- end }}
