{{/*
Copyright 2026 Daniil Romashov
SPDX-License-Identifier: Apache-2.0
*/}}

{{- define "grpc-streams-checker.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "grpc-streams-checker.fullname" -}}
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

{{- define "grpc-streams-checker.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "grpc-streams-checker.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "grpc-streams-checker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "grpc-streams-checker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "grpc-streams-checker.configMapName" -}}
{{- default (printf "%s-config" (include "grpc-streams-checker.fullname" .)) .Values.existingConfigMap }}
{{- end }}

{{- define "grpc-streams-checker.protosConfigMapName" -}}
{{- default (printf "%s-protos" (include "grpc-streams-checker.fullname" .)) .Values.existingProtosConfigMap }}
{{- end }}

{{- define "grpc-streams-checker.hasProtos" -}}
{{- if or .Values.existingProtosConfigMap .Values.protos }}true{{ end }}
{{- end }}
