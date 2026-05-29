package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
)

// UploadServiceBackup stages a local service archive onto the box's NAS via the
// #1351 route (`POST /api/system/external-backup/upload`). It posts multipart
// form data — a `service` field + the archive as `file` — authenticated with
// the scoped token (a valid Bearer bypasses the proxy CSRF gate, so no Origin
// header is needed). Returns the staged tar name the box reports.
func (c *Client) UploadServiceBackup(ctx context.Context, service, fileName string, data []byte) (string, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	if err := w.WriteField("service", service); err != nil {
		return "", &APIError{Message: err.Error()}
	}
	fw, err := w.CreateFormFile("file", fileName)
	if err != nil {
		return "", &APIError{Message: err.Error()}
	}
	if _, err := fw.Write(data); err != nil {
		return "", &APIError{Message: err.Error()}
	}
	if err := w.Close(); err != nil {
		return "", &APIError{Message: err.Error()}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/system/external-backup/upload", &body)
	if err != nil {
		return "", &APIError{Message: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", w.FormDataContentType())

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", &APIError{Message: fmt.Sprintf("cannot reach box: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized {
		return "", ErrUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &APIError{Status: resp.StatusCode, Message: serverError(raw, resp.StatusCode)}
	}
	var out struct {
		TarName string `json:"tarName"`
	}
	_ = json.Unmarshal(raw, &out)
	return out.TarName, nil
}
