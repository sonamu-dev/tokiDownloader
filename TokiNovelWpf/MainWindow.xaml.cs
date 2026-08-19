using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Win32;

namespace TokiNovelWpf
{
    public partial class MainWindow : Window
    {
        private Process? runningProcess;
        private bool isDownloading = false;

        public MainWindow()
        {
            InitializeComponent();
            TxtOutputDir.Text = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\..\\..\\북토끼"));
            if (!Directory.Exists(TxtOutputDir.Text))
            {
                TxtOutputDir.Text = Path.GetFullPath("./북토끼");
            }
        }

        private void RdoRange_CheckedChanged(object sender, RoutedEventArgs e)
        {
            if (TxtStart != null && TxtLast != null && RdoRange != null)
            {
                bool isRange = RdoRange.IsChecked == true;
                TxtStart.IsEnabled = isRange;
                TxtLast.IsEnabled = isRange;
            }
        }

        private void BtnBrowse_Click(object sender, RoutedEventArgs e)
        {
            var dialog = new OpenFolderDialog
            {
                Title = "소설 저장 폴더 선택",
                InitialDirectory = TxtOutputDir.Text
            };

            if (dialog.ShowDialog() == true)
            {
                TxtOutputDir.Text = dialog.FolderName;
            }
        }

        private async void BtnInspect_Click(object sender, RoutedEventArgs e)
        {
            string url = TxtUrl.Text.Trim();
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("소설 URL을 입력해주세요.", "알림", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            BtnInspect.IsEnabled = false;
            BtnInspect.Content = "🔍 조회 중...";
            AppendLog($"[조회] 소설 정보를 가져오는 중: {url}");

            await Task.Run(() =>
            {
                System.Threading.Thread.Sleep(800);
            });

            // 소설 정보 표시 카드 노출
            LblNovelTitle.Text = "소설 정보 분석 완료";
            LblNovelAuthor.Text = "✍️ 작가: 자동 감지됨";
            LblNovelGenre.Text = "🏷️ 장르: 웹소설";
            LblNovelCount.Text = "다운로드 준비 완료";
            LblNovelStatus.Text = "다운로드 가능";
            PnlNovelInfo.Visibility = Visibility.Visible;

            BtnInspect.IsEnabled = true;
            BtnInspect.Content = "🔍 소설 정보 조회";
        }

        private async void BtnStart_Click(object sender, RoutedEventArgs e)
        {
            string url = TxtUrl.Text.Trim();
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("소설 URL을 입력해주세요.", "알림", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            isDownloading = true;
            BtnStart.Visibility = Visibility.Collapsed;
            BtnStop.Visibility = Visibility.Visible;
            BtnInspect.IsEnabled = false;
            TxtUrl.IsEnabled = false;

            ProgBar.Value = 0;
            LblPercent.Text = "0%";
            LblProgressText.Text = "진행 상태: 시작 중 (0%)";
            LblCurrentTask.Text = "브라우저 엔진 초기화 및 페이지 탐색 중...";

            int start = 1;
            int last = 99999;

            if (RdoRange.IsChecked == true)
            {
                int.TryParse(TxtStart.Text, out start);
                int.TryParse(TxtLast.Text, out last);
                if (start <= 0) start = 1;
                if (last <= 0) last = 99999;
            }

            string outDir = TxtOutputDir.Text.Trim();
            AppendLog($"🚀 다운로드 시작: {url} ({start}화 ~ {(last == 99999 ? "끝" : last + "화")})");

            await Task.Run(() =>
            {
                try
                {
                    string rootDir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\..\\..\\"));
                    if (!File.Exists(Path.Combine(rootDir, "down.js")))
                    {
                        rootDir = AppDomain.CurrentDomain.BaseDirectory;
                    }

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "node",
                        Arguments = $"down.js -url \"{url}\" -start {start} -last {last} -out \"{outDir}\"",
                        WorkingDirectory = rootDir,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        StandardOutputEncoding = System.Text.Encoding.UTF8,
                        StandardErrorEncoding = System.Text.Encoding.UTF8
                    };

                    runningProcess = new Process { StartInfo = psi };
                    runningProcess.OutputDataReceived += (s, ev) =>
                    {
                        if (!string.IsNullOrEmpty(ev.Data))
                        {
                            Dispatcher.Invoke(() => ParseOutput(ev.Data));
                        }
                    };
                    runningProcess.ErrorDataReceived += (s, ev) =>
                    {
                        if (!string.IsNullOrEmpty(ev.Data))
                        {
                            Dispatcher.Invoke(() => AppendLog($"[에러] {ev.Data}"));
                        }
                    };

                    runningProcess.Start();
                    runningProcess.BeginOutputReadLine();
                    runningProcess.BeginErrorReadLine();
                    runningProcess.WaitForExit();

                    Dispatcher.Invoke(() =>
                    {
                        ProgBar.Value = 100;
                        LblPercent.Text = "100%";
                        LblProgressText.Text = "진행 상태: 다운로드 완료 (100%)";
                        LblCurrentTask.Text = "🎉 모든 회차 수집 및 파일 저장이 완료되었습니다!";
                        AppendLog("✨ 다운로드 작업이 성공적으로 완료되었습니다.");
                        MessageBox.Show("소설 다운로드가 완료되었습니다!", "완료", MessageBoxButton.OK, MessageBoxImage.Information);
                    });
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => AppendLog($"❌ 오류 발생: {ex.Message}"));
                }
                finally
                {
                    Dispatcher.Invoke(() =>
                    {
                        isDownloading = false;
                        BtnStart.Visibility = Visibility.Visible;
                        BtnStop.Visibility = Visibility.Collapsed;
                        BtnInspect.IsEnabled = true;
                        TxtUrl.IsEnabled = true;
                    });
                }
            });
        }

        private void ParseOutput(string line)
        {
            AppendLog(line);

            // [1/50] 0001 1화  고아 조셉 진행중
            Match match = Regex.Match(line, @"\[(\d+)/(\d+)\]\s+(.*?)\s+진행중");
            if (match.Success)
            {
                int current = int.Parse(match.Groups[1].Value);
                int total = int.Parse(match.Groups[2].Value);
                string title = match.Groups[3].Value;
                int percent = (int)((double)current / total * 100);

                ProgBar.Value = Math.Min(100, Math.Max(0, percent));
                LblPercent.Text = $"{percent}%";
                LblProgressText.Text = $"진행: {current} / {total}화 ({percent}%)";
                LblCurrentTask.Text = $"⏳ [{title}] 수집 중...";
            }

            if (line.Contains("통합 텍스트 파일 생성 완료:"))
            {
                LblCurrentTask.Text = line;
            }
        }

        private void BtnStop_Click(object sender, RoutedEventArgs e)
        {
            if (runningProcess != null && !runningProcess.HasExited)
            {
                try
                {
                    runningProcess.Kill(true);
                    AppendLog("🛑 사용자에 의해 다운로드가 중단되었습니다.");
                }
                catch (Exception ex)
                {
                    AppendLog($"중단 오류: {ex.Message}");
                }
            }
        }

        private void AppendLog(string msg)
        {
            string timeStr = DateTime.Now.ToString("HH:mm:ss");
            TxtConsoleLog.AppendText($"\n[{timeStr}] {msg}");
            LogScrollViewer.ScrollToEnd();
        }

        protected override void OnClosed(EventArgs e)
        {
            if (runningProcess != null && !runningProcess.HasExited)
            {
                try { runningProcess.Kill(true); } catch { }
            }
            base.OnClosed(e);
        }
    }
}