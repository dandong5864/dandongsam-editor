// 단동샘 편집기 실행 프로그램 (윈도우용)
// 1) 그냥 실행하면: runtime\node.exe server.js 를 창 없이 켜요. (예전 실행 프로그램과 같아요)
// 2) 편집기가 "--window 주소" 로 다시 부르면: 위쪽 회색 제목 줄이 없는 편집기 창을 띄워요. (윈도우 기본 WebView2 사용)
//    WebView2 를 쓸 수 없는 컴퓨터에서는 편집기가 예전처럼 엣지 창으로 열어요.
// 만들기: tools/window/build.sh
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <string>
#include "WebView2.h"

static const wchar_t *CLS = L"DandongsamEditorWindow";
static HWND g_hwnd = nullptr;
static ICoreWebView2Controller *g_ctrl = nullptr;
static ICoreWebView2 *g_view = nullptr;
static std::wstring g_url;
static const int EDGE = 5;   // 창 크기를 바꾸는 테두리 두께
static const COLORREF BG = RGB(0x1c, 0x1c, 0x20);

typedef HRESULT(STDAPICALLTYPE *CreateEnvFn)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
typedef HRESULT(STDAPICALLTYPE *VersionFn)(PCWSTR, LPWSTR *);

static std::wstring exeDir() {
  wchar_t p[MAX_PATH * 2]; DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH * 2); std::wstring s(p, n);
  size_t k = s.find_last_of(L"\\/"); return k == std::wstring::npos ? L"." : s.substr(0, k);
}
static std::wstring exePath() { wchar_t p[MAX_PATH * 2]; DWORD n = GetModuleFileNameW(nullptr, p, MAX_PATH * 2); return std::wstring(p, n); }

static HMODULE loadLoader() { return LoadLibraryW((exeDir() + L"\\WebView2Loader.dll").c_str()); }
static bool webviewReady() {
  HMODULE m = loadLoader(); if (!m) return false;
  VersionFn f = (VersionFn)GetProcAddress(m, "GetAvailableCoreWebView2BrowserVersionString");
  LPWSTR v = nullptr; bool ok = f && SUCCEEDED(f(nullptr, &v)) && v && *v; if (v) CoTaskMemFree(v); return ok;
}

// ---------- 1) 편집기 켜기 ----------
static int startServer() {
  std::wstring dir = exeDir();
  SetEnvironmentVariableW(L"AUTO_QUIT", L"1");
  if (webviewReady()) SetEnvironmentVariableW(L"DDS_WINDOW", exePath().c_str());
  std::wstring node = dir + L"\\runtime\\node.exe";
  std::wstring cmd = L"\"" + node + L"\" server.js";
  STARTUPINFOW si = { sizeof(si) }; PROCESS_INFORMATION pi = {};
  if (!CreateProcessW(node.c_str(), &cmd[0], nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, dir.c_str(), &si, &pi)) {
    MessageBoxW(nullptr, L"편집기를 켜지 못했어요. 폴더 안의 [단동샘 편집기 (문제 해결용).bat] 을 실행해 보세요.", L"단동샘 편집기", MB_ICONERROR);
    return 1;
  }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return 0;
}

// ---------- 2) 편집기 창 ----------
template <class I> struct Handler : I {
  ULONG ref = 1;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void **p) override { *p = this; AddRef(); return S_OK; }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++ref; }
  ULONG STDMETHODCALLTYPE Release() override { ULONG r = --ref; if (!r) delete this; return r; }
};
#define HANDLER(NAME, IFACE, ARGS, BODY) struct NAME : Handler<IFACE> { HRESULT STDMETHODCALLTYPE Invoke ARGS override BODY };

static void post(const wchar_t *s) { if (g_view) g_view->PostWebMessageAsString(s); }
static void sendState() { post(IsZoomed(g_hwnd) ? L"win:max" : L"win:normal"); }
static void fit() {
  if (!g_ctrl) return; RECT r; GetClientRect(g_hwnd, &r);
  if (!IsZoomed(g_hwnd)) { r.left += EDGE; r.right -= EDGE; r.bottom -= EDGE; r.top += 1; }
  g_ctrl->put_Bounds(r);
}
static void openOutside(LPCWSTR uri) { ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL); }
static bool isLocal(const std::wstring &u) {
  for (const wchar_t *p : { L"http://localhost:", L"http://127.0.0.1:" }) if (u.rfind(p, 0) == 0) return true;
  return false;
}

HANDLER(OnMsg, ICoreWebView2WebMessageReceivedEventHandler, (ICoreWebView2 *, ICoreWebView2WebMessageReceivedEventArgs *a), {
  LPWSTR m = nullptr; if (FAILED(a->TryGetWebMessageAsString(&m)) || !m) return S_OK;
  std::wstring s(m); CoTaskMemFree(m);
  if (s == L"win:min") ShowWindow(g_hwnd, SW_MINIMIZE);
  else if (s == L"win:max") ShowWindow(g_hwnd, IsZoomed(g_hwnd) ? SW_RESTORE : SW_MAXIMIZE);
  else if (s == L"win:close") PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
  else if (s == L"win:drag") { POINT pt; GetCursorPos(&pt); ReleaseCapture(); PostMessageW(g_hwnd, WM_NCLBUTTONDOWN, HTCAPTION, MAKELPARAM(pt.x, pt.y)); }
  else if (s == L"win:hello") sendState();
  return S_OK;
})
HANDLER(OnTitle, ICoreWebView2DocumentTitleChangedEventHandler, (ICoreWebView2 *v, IUnknown *), {
  LPWSTR t = nullptr; if (SUCCEEDED(v->get_DocumentTitle(&t)) && t) { SetWindowTextW(g_hwnd, t); CoTaskMemFree(t); } return S_OK;
})
HANDLER(OnNewWin, ICoreWebView2NewWindowRequestedEventHandler, (ICoreWebView2 *, ICoreWebView2NewWindowRequestedEventArgs *a), {
  // 사용법·설문지 같은 바깥 주소는 평소 쓰는 인터넷 창에서 열어요
  LPWSTR u = nullptr; if (SUCCEEDED(a->get_Uri(&u)) && u) { std::wstring s(u); CoTaskMemFree(u); if (!isLocal(s)) { a->put_Handled(TRUE); if (s.rfind(L"http", 0) == 0) openOutside(s.c_str()); } }
  return S_OK;
})
HANDLER(OnCloseReq, ICoreWebView2WindowCloseRequestedEventHandler, (ICoreWebView2 *, IUnknown *), { PostMessageW(g_hwnd, WM_CLOSE, 0, 0); return S_OK; })
HANDLER(OnCtrl, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, (HRESULT hr, ICoreWebView2Controller *c), {
  if (FAILED(hr) || !c) { MessageBoxW(g_hwnd, L"편집기 화면을 열지 못했어요. 엣지 창으로 다시 열어 볼게요.", L"단동샘 편집기", MB_ICONWARNING); openOutside(g_url.c_str()); PostMessageW(g_hwnd, WM_CLOSE, 0, 0); return S_OK; }
  g_ctrl = c; g_ctrl->AddRef(); g_ctrl->get_CoreWebView2(&g_view);
  ICoreWebView2Settings *st = nullptr;
  if (SUCCEEDED(g_view->get_Settings(&st)) && st) { st->put_IsStatusBarEnabled(FALSE); st->put_IsZoomControlEnabled(FALSE); st->Release(); }
  EventRegistrationToken tk;
  g_view->add_WebMessageReceived(new OnMsg(), &tk);
  g_view->add_DocumentTitleChanged(new OnTitle(), &tk);
  g_view->add_NewWindowRequested(new OnNewWin(), &tk);
  g_view->add_WindowCloseRequested(new OnCloseReq(), &tk);
  fit(); g_ctrl->put_IsVisible(TRUE); g_ctrl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  g_view->Navigate(g_url.c_str());
  return S_OK;
})
HANDLER(OnEnv, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, (HRESULT hr, ICoreWebView2Environment *e), {
  if (FAILED(hr) || !e) { openOutside(g_url.c_str()); PostMessageW(g_hwnd, WM_CLOSE, 0, 0); return S_OK; }
  return e->CreateCoreWebView2Controller(g_hwnd, new OnCtrl());
})

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
  case WM_NCCALCSIZE:   // 위쪽 회색 제목 줄을 없애요 (창 전체를 편집기 화면으로)
    if (w) {
      if (IsZoomed(h)) {   // 최대화하면 화면 밖으로 넘치는 테두리만큼 줄여요
        NCCALCSIZE_PARAMS *p = (NCCALCSIZE_PARAMS *)l;
        int fx = GetSystemMetrics(SM_CXFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER), fy = GetSystemMetrics(SM_CYFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER);
        p->rgrc[0].left += fx; p->rgrc[0].right -= fx; p->rgrc[0].top += fy; p->rgrc[0].bottom -= fy;
      }
      return 0;
    }
    break;
  case WM_NCHITTEST: {   // 가장자리를 끌면 창 크기가 바뀌어요
    if (IsZoomed(h)) return HTCLIENT;
    POINT pt = { GET_X_LPARAM(l), GET_Y_LPARAM(l) }; RECT r; GetWindowRect(h, &r);
    bool L = pt.x < r.left + EDGE, R = pt.x >= r.right - EDGE, T = pt.y < r.top + EDGE, B = pt.y >= r.bottom - EDGE;
    if (T && L) return HTTOPLEFT; if (T && R) return HTTOPRIGHT; if (B && L) return HTBOTTOMLEFT; if (B && R) return HTBOTTOMRIGHT;
    if (L) return HTLEFT; if (R) return HTRIGHT; if (T) return HTTOP; if (B) return HTBOTTOM;
    return HTCLIENT;
  }
  case WM_ERASEBKGND: { RECT r; GetClientRect(h, &r); HBRUSH b = CreateSolidBrush(BG); FillRect((HDC)w, &r, b); DeleteObject(b); return 1; }
  case WM_SIZE: fit(); if (w != SIZE_MINIMIZED) sendState(); InvalidateRect(h, nullptr, TRUE); return 0;
  case WM_MOVE: case WM_MOVING: if (g_ctrl) g_ctrl->NotifyParentWindowPositionChanged(); break;
  case WM_GETMINMAXINFO: ((MINMAXINFO *)l)->ptMinTrackSize = { 900, 560 }; return 0;
  case WM_SETFOCUS: if (g_ctrl) g_ctrl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC); return 0;
  case WM_CLOSE: if (g_ctrl) { g_ctrl->Close(); g_ctrl->Release(); g_ctrl = nullptr; } DestroyWindow(h); return 0;
  case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

static int runWindow(const std::wstring &url) {
  g_url = url;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  HINSTANCE inst = GetModuleHandleW(nullptr);
  WNDCLASSEXW wc = { sizeof(wc) }; wc.lpfnWndProc = WndProc; wc.hInstance = inst; wc.lpszClassName = CLS;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW); wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1)); wc.hIconSm = wc.hIcon;
  RegisterClassExW(&wc);
  RECT wa; SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
  int W = (wa.right - wa.left) * 9 / 10, H = (wa.bottom - wa.top) * 9 / 10;
  g_hwnd = CreateWindowExW(0, CLS, L"단동샘 편집기", WS_OVERLAPPEDWINDOW, wa.left + (wa.right - wa.left - W) / 2, wa.top + (wa.bottom - wa.top - H) / 2, W, H, nullptr, nullptr, inst, nullptr);
  SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  ShowWindow(g_hwnd, SW_SHOWMAXIMIZED);
  SetEnvironmentVariableW(L"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", L"FF141416");
  wchar_t la[MAX_PATH]; DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", la, MAX_PATH);
  std::wstring data = (n ? std::wstring(la, n) : exeDir()) + L"\\단동샘편집기\\창";
  CreateEnvFn create = nullptr; HMODULE m = loadLoader(); if (m) create = (CreateEnvFn)GetProcAddress(m, "CreateCoreWebView2EnvironmentWithOptions");
  if (!create || FAILED(create(nullptr, data.c_str(), nullptr, new OnEnv()))) { openOutside(url.c_str()); return 0; }
  MSG msg; while (GetMessageW(&msg, nullptr, 0, 0)) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  CoUninitialize(); return 0;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  int argc = 0; LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argc >= 3 && std::wstring(argv[1]) == L"--window") {
    std::wstring url = argv[2];
    if (!isLocal(url)) return 1;   // 편집기 주소만 열어요
    return runWindow(url);
  }
  return startServer();
}
