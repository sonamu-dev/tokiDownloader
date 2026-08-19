using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using Microsoft.Win32;

namespace TokiNovelWpf
{
    public class NovelMetaInfo
    {
        public string Url { get; set; } = "";
        public string Title { get; set; } = "";
        public string Author { get; set; } = "";
        public string Genre { get; set; } = "";
        public bool IsCompleted { get; set; }
        public string PublishStatus { get; set; } = "연재중";
        public int TotalEpisodes { get; set; }
        public int MinNum { get; set; } = 1;
        public int MaxNum { get; set; } = 99999;
    }

    public class DownloadItem : INotifyPropertyChanged
    {
        public string Url { get; set; } = "";
        public string Title { get; set; } = "소설";
        public int StartNum { get; set; } = 1;
        public int LastNum { get; set; } = 99999;
        public string OutputDir { get; set; } = "";
        public string IndexStr { get; set; } = "[1]";
        public string RangeStr { get; set; } = "전체";

        private string _statusText = "대기중";
        public string StatusText
        {
            get => _statusText;
            set { _statusText = value; OnPropertyChanged(nameof(StatusText)); }
        }

        private Brush _statusBg = new SolidColorBrush(Color.FromRgb(71, 85, 105)); // Slate
        public Brush StatusBg
        {
            get => _statusBg;
            set { _statusBg = value; OnPropertyChanged(nameof(StatusBg)); }
        }

        public event PropertyChangedEventHandler? PropertyChanged;
        protected void OnPropertyChanged(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
    }

    public partial class MainWindow : Window
    {
        private ObservableCollection<DownloadItem> queueList = new ObservableCollection<DownloadItem>();
        private Dictionary<string, NovelMetaInfo> metaCache = new Dictionary<string, NovelMetaInfo>();
        private Process? runningProcess;
        private bool isDownloading = false;
        private bool abortRequested = false;

        [Flags]
        private enum EXECUTION_STATE : uint
        {
            ES_AWAYMODE_REQUIRED = 0x00000040,
            ES_CONTINUOUS = 0x80000000,
            ES_SYSTEM_REQUIRED = 0x00000001
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto, SetLastError = true)]
        private static extern EXECUTION_STATE SetThreadExecutionState(EXECUTION_STATE esFlags);

        public MainWindow()
        {
            InitializeComponent();
            LstQueue.ItemsSource = queueList;

            TxtOutputDir.Text = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\..\\..\\북토끼"));
            if (!Directory.Exists(TxtOutputDir.Text))
            {
                TxtOutputDir.Text = Path.GetFullPath("./북토끼");
            }
        }

        private void PreventSystemSleep()
        {
            try
            {
                SetThreadExecutionState(EXECUTION_STATE.ES_CONTINUOUS | EXECUTION_STATE.ES_SYSTEM_REQUIRED | EXECUTION_STATE.ES_AWAYMODE_REQUIRED);
            }
            catch { }
        }

        private void RestoreSystemSleep()
        {
            try
            {
                SetThreadExecutionState(EXECUTION_STATE.ES_CONTINUOUS);
            }
            catch { }
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

        private async Task<NovelMetaInfo?> FetchNovelMetaAsync(string url)
        {
            if (metaCache.TryGetValue(url, out var cached))
            {
                return cached;
            }

            AppendLog($"[조회] 소설 정보를 가져오는 중: {url}");

            return await Task.Run(() =>
            {
                try
                {
                    string rootDir = GetProjectRootDir();
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "node",
                        Arguments = $"down.js -url \"{url}\" -inspect",
                        WorkingDirectory = rootDir,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        StandardOutputEncoding = System.Text.Encoding.UTF8,
                        StandardErrorEncoding = System.Text.Encoding.UTF8
                    };

                    using Process proc = new Process { StartInfo = psi };
                    string output = "";
                    proc.OutputDataReceived += (s, ev) =>
                    {
                        if (!string.IsNullOrEmpty(ev.Data)) output += ev.Data + "\n";
                    };
                    proc.Start();
                    proc.BeginOutputReadLine();
                    proc.WaitForExit();

                    Match match = Regex.Match(output, @"JSON_OUTPUT:(\{.*?\})");
                    if (match.Success)
                    {
                        string jsonStr = match.Groups[1].Value;
                        using var doc = System.Text.Json.JsonDocument.Parse(jsonStr);
                        var root = doc.RootElement;

                        var meta = new NovelMetaInfo
                        {
                            Url = url,
                            Title = root.GetProperty("title").GetString() ?? "소설",
                            Author = root.GetProperty("author").GetString() ?? "미상",
                            Genre = root.GetProperty("firstGenre").GetString() ?? "일반",
                            IsCompleted = root.GetProperty("isCompleted").GetBoolean(),
                            PublishStatus = root.GetProperty("publishStatus").GetString() ?? "연재중",
                            TotalEpisodes = root.GetProperty("totalEpisodes").GetInt32(),
                            MinNum = root.GetProperty("minNum").GetInt32(),
                            MaxNum = root.GetProperty("maxNum").GetInt32()
                        };

                        metaCache[url] = meta;
                        return meta;
                    }
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => AppendLog($"[조회 에러] {ex.Message}"));
                }
                return null;
            });
        }

        private void UpdateNovelInfoCard(NovelMetaInfo meta)
        {
            LblNovelTitle.Text = meta.Title;
            LblNovelAuthor.Text = $"✍️ 작가: {meta.Author}";
            LblNovelGenre.Text = $"🏷️ 장르: {meta.Genre}";
            LblNovelCount.Text = $"총 {meta.TotalEpisodes}화";
            LblNovelStatus.Text = meta.PublishStatus;

            if (meta.IsCompleted)
            {
                BadgeStatus.Background = new SolidColorBrush(Color.FromRgb(5, 150, 105)); // 초록
            }
            else
            {
                BadgeStatus.Background = new SolidColorBrush(Color.FromRgb(79, 70, 229)); // 인디고
            }

            RdoAll.Content = $"전체 다운로드 ({meta.MinNum}화 ~ {meta.MaxNum}화)";
            TxtStart.Text = meta.MinNum.ToString();
            TxtLast.Text = meta.MaxNum.ToString();

            PnlNovelInfo.Visibility = Visibility.Visible;
            AppendLog($"[조회 성공] {meta.Title} (작가: {meta.Author}, 장르: {meta.Genre}, 총 {meta.TotalEpisodes}화, {meta.PublishStatus})");
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
            BtnInspect.Content = "조회 중...";

            var meta = await FetchNovelMetaAsync(url);
            if (meta != null)
            {
                UpdateNovelInfoCard(meta);
            }
            else
            {
                AppendLog("[조회 실패] 소설 정보를 가져오지 못했습니다. URL을 확인해주세요.");
            }

            BtnInspect.IsEnabled = true;
            BtnInspect.Content = "🔍 소설 정보 조회";
        }

        private async void BtnAddToQueue_Click(object sender, RoutedEventArgs e)
        {
            string url = TxtUrl.Text.Trim();
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("소설 URL을 입력해주세요.", "알림", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }

            BtnAddToQueue.IsEnabled = false;
            BtnAddToQueue.Content = "추가 중...";

            // 소설 정보를 먼저 정확하게 조회 (캐시가 있으면 즉시 반환, 없으면 안전하게 조회)
            var meta = await FetchNovelMetaAsync(url);
            if (meta != null)
            {
                UpdateNovelInfoCard(meta);
            }

            int start = 1;
            int last = meta != null ? meta.MaxNum : 99999;
            string rangeText = meta != null && meta.IsCompleted ? $"1~{meta.MaxNum}화 [완결]" : $"전체 (1~{last}화)";

            if (RdoRange.IsChecked == true)
            {
                int.TryParse(TxtStart.Text, out start);
                int.TryParse(TxtLast.Text, out last);
                if (start <= 0) start = 1;
                if (last <= 0) last = (meta != null ? meta.MaxNum : 99999);
                rangeText = $"{start}화~{last}화";
            }

            string finalTitle = meta != null ? meta.Title : url;

            var item = new DownloadItem
            {
                Url = url,
                Title = finalTitle,
                StartNum = start,
                LastNum = last,
                OutputDir = TxtOutputDir.Text.Trim(),
                IndexStr = $"[{queueList.Count + 1}]",
                RangeStr = rangeText,
                StatusText = "대기중",
                StatusBg = new SolidColorBrush(Color.FromRgb(71, 85, 105))
            };

            queueList.Add(item);
            AppendLog($"➕ 대기열에 추가됨: {finalTitle} ({rangeText})");

            BtnAddToQueue.IsEnabled = true;
            BtnAddToQueue.Content = "➕ 대기열에 추가";
        }

        private void BtnRemoveSelected_Click(object sender, RoutedEventArgs e)
        {
            if (LstQueue.SelectedItem is DownloadItem selected)
            {
                queueList.Remove(selected);
                ReindexQueue();
            }
        }

        private void BtnClearQueue_Click(object sender, RoutedEventArgs e)
        {
            queueList.Clear();
            AppendLog("🧹 대기열을 비웠습니다.");
        }

        private void ReindexQueue()
        {
            for (int i = 0; i < queueList.Count; i++)
            {
                queueList[i].IndexStr = $"[{i + 1}]";
            }
        }

        private async void BtnStart_Click(object sender, RoutedEventArgs e)
        {
            // 대기열이 비어 있으면 현재 URL을 자동 추가
            if (queueList.Count == 0)
            {
                string url = TxtUrl.Text.Trim();
                if (string.IsNullOrEmpty(url))
                {
                    MessageBox.Show("다운로드할 소설 URL을 입력하거나 대기열에 추가해주세요.", "알림", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return;
                }
                BtnAddToQueue_Click(sender, e);
                await Task.Delay(500);
            }

            isDownloading = true;
            abortRequested = false;
            PreventSystemSleep(); // 화면 잠금 시에도 시스템 절전 방지

            BtnStart.Visibility = Visibility.Collapsed;
            BtnStop.Visibility = Visibility.Visible;
            BtnInspect.IsEnabled = false;
            BtnAddToQueue.IsEnabled = false;
            TxtUrl.IsEnabled = false;

            bool autoShutdown = ChkAutoShutdown.IsChecked == true;
            AppendLog($"🚀 총 {queueList.Count}개 소설 순차 대기열 다운로드를 시작합니다.");
            if (autoShutdown)
            {
                AppendLog("⚡ [자동 종료] 모든 다운로드가 완료되면 컴퓨터가 60초 후 자동으로 종료됩니다. (화면 잠금 시에도 전원 OFF)");
            }

            await Task.Run(async () =>
            {
                for (int i = 0; i < queueList.Count; i++)
                {
                    if (abortRequested) break;

                    var item = queueList[i];
                    Dispatcher.Invoke(() =>
                    {
                        item.StatusText = "진행중 (0%)";
                        item.StatusBg = new SolidColorBrush(Color.FromRgb(168, 85, 247)); // 퍼플
                        LblGlobalStatus.Text = $"소설 {i + 1}/{queueList.Count} 수집중";
                        LblCurrentTask.Text = $"[{item.Title}] 다운로드 준비 중...";
                    });

                    AppendLog($"\n==================================================");
                    AppendLog($"📚 [{i + 1}/{queueList.Count}] {item.Title} 다운로드 시작");
                    AppendLog($"==================================================");

                    bool success = await DownloadSingleNovelAsync(item);

                    Dispatcher.Invoke(() =>
                    {
                        if (success)
                        {
                            item.StatusText = "완료";
                            item.StatusBg = new SolidColorBrush(Color.FromRgb(16, 185, 129)); // 에메랄드 그린
                        }
                        else
                        {
                            item.StatusText = abortRequested ? "중단됨" : "실패";
                            item.StatusBg = new SolidColorBrush(Color.FromRgb(239, 68, 68)); // 빨강
                        }
                    });
                }

                Dispatcher.Invoke(() =>
                {
                    isDownloading = false;
                    RestoreSystemSleep();

                    BtnStart.Visibility = Visibility.Visible;
                    BtnStop.Visibility = Visibility.Collapsed;
                    BtnInspect.IsEnabled = true;
                    BtnAddToQueue.IsEnabled = true;
                    TxtUrl.IsEnabled = true;

                    ProgBar.Value = 100;
                    LblPercent.Text = "100%";
                    LblProgressText.Text = "모든 대기열 작업 완료!";
                    LblGlobalStatus.Text = "작업 완료";
                    LblCurrentTask.Text = "🎉 모든 대기열 소설의 다운로드가 완료되었습니다!";
                    AppendLog("\n✨ 모든 대기열의 다운로드 작업이 완료되었습니다.");

                    if (autoShutdown && !abortRequested)
                    {
                        ExecuteSystemShutdown();
                    }
                    else
                    {
                        MessageBox.Show("모든 소설 다운로드가 완료되었습니다!", "완료", MessageBoxButton.OK, MessageBoxImage.Information);
                    }
                });
            });
        }

        private async Task<bool> DownloadSingleNovelAsync(DownloadItem item)
        {
            return await Task.Run(() =>
            {
                try
                {
                    string rootDir = GetProjectRootDir();
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "node",
                        Arguments = $"down.js -url \"{item.Url}\" -start {item.StartNum} -last {item.LastNum} -out \"{item.OutputDir}\"",
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
                            Dispatcher.Invoke(() => ParseOutput(ev.Data, item));
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

                    return runningProcess.ExitCode == 0;
                }
                catch (Exception ex)
                {
                    Dispatcher.Invoke(() => AppendLog($"❌ 오류 발생: {ex.Message}"));
                    return false;
                }
            });
        }

        private void ParseOutput(string line, DownloadItem item)
        {
            AppendLog(line);

            // 진행률 파싱: [1/50] 0001 1화 진행중
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
                item.StatusText = $"{percent}%";
            }

            if (line.Contains("통합 텍스트 파일 생성 완료:"))
            {
                LblCurrentTask.Text = line;
            }
        }

        private void ExecuteSystemShutdown()
        {
            AppendLog("\n⚡ [전원 끄기] 모든 다운로드가 완료되어 60초 후 시스템을 종료합니다.");
            AppendLog("💡 취소하려면 Windows 시작 - 실행에서 'shutdown /a' 를 입력하세요.");

            try
            {
                // 화면이 잠겨 있어도 60초 후 완벽하게 시스템 종료 실행
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "shutdown.exe",
                    Arguments = "/s /t 60 /c \"Toki Novel Downloader: 모든 다운로드가 완료되어 시스템을 종료합니다.\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                Process.Start(psi);

                MessageBox.Show("모든 소설 다운로드가 완료되었습니다!\n60초 후 컴퓨터가 자동으로 종료됩니다.\n(취소하려면 '확인'을 누르고 터미널에 shutdown /a를 입력하세요)", "자동 시스템 종료", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            catch (Exception ex)
            {
                AppendLog($"시스템 종료 명령 실행 실패: {ex.Message}");
            }
        }

        private void BtnStop_Click(object sender, RoutedEventArgs e)
        {
            abortRequested = true;
            RestoreSystemSleep();
            if (runningProcess != null && !runningProcess.HasExited)
            {
                try
                {
                    runningProcess.Kill(true);
                    AppendLog("🛑 사용자에 의해 다운로드 작업이 중단되었습니다.");
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

        private string GetProjectRootDir()
        {
            string rootDir = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\..\\..\\"));
            if (!File.Exists(Path.Combine(rootDir, "down.js")))
            {
                rootDir = AppDomain.CurrentDomain.BaseDirectory;
            }
            return rootDir;
        }

        protected override void OnClosed(EventArgs e)
        {
            abortRequested = true;
            RestoreSystemSleep();
            if (runningProcess != null && !runningProcess.HasExited)
            {
                try { runningProcess.Kill(true); } catch { }
            }
            base.OnClosed(e);
        }
    }
}