using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
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

        private double _progressValue = 0;
        public double ProgressValue
        {
            get => _progressValue;
            set { _progressValue = value; OnPropertyChanged(nameof(ProgressValue)); }
        }

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

            string rootDir = GetProjectRootDir();
            TxtOutputDir.Text = Path.Combine(rootDir, "북토끼");

            LoadQueueFromFile();
        }

        private void SaveQueueToFile()
        {
            try
            {
                string json = System.Text.Json.JsonSerializer.Serialize(queueList, new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText("queue_history.json", json);
            }
            catch { }
        }

        private void LoadQueueFromFile()
        {
            try
            {
                if (File.Exists("queue_history.json"))
                {
                    string json = File.ReadAllText("queue_history.json");
                    var items = System.Text.Json.JsonSerializer.Deserialize<List<DownloadItem>>(json);
                    if (items != null && items.Count > 0)
                    {
                        queueList.Clear();
                        foreach (var it in items)
                        {
                            it.StatusText = "대기중";
                            it.StatusBg = new SolidColorBrush(Color.FromRgb(71, 85, 105));
                            queueList.Add(it);
                        }
                        ReindexQueue();
                        AppendLog($"📋 이전 대기열 목록 {queueList.Count}개를 성공적으로 복원했습니다.");
                    }
                }
            }
            catch { }
        }

        private void PreventSystemSleep()
        {
            try
            {
                SetThreadExecutionState(EXECUTION_STATE.ES_CONTINUOUS | EXECUTION_STATE.ES_SYSTEM_REQUIRED | EXECUTION_STATE.ES_AWAYMODE_REQUIRED);
            }
            catch { }
        }

        private bool isUpdatingTextProgrammatically = false;

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
            if (RdoRange != null && RdoRange.IsChecked == true)
            {
                Dispatcher.BeginInvoke(new Action(() =>
                {
                    TxtStart?.Focus();
                    TxtStart?.SelectAll();
                }), System.Windows.Threading.DispatcherPriority.Input);
            }
        }

        private void TxtRange_GotFocus(object sender, RoutedEventArgs e)
        {
            if (RdoRange != null && RdoRange.IsChecked != true)
            {
                RdoRange.IsChecked = true;
            }
            if (sender is TextBox tb)
            {
                tb.SelectAll();
            }
        }

        private void TxtRange_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (sender is TextBox tb && !tb.IsKeyboardFocusWithin)
            {
                e.Handled = true;
                tb.Focus();
                tb.SelectAll();
            }
        }

        private void TxtRange_TextChanged(object sender, TextChangedEventArgs e)
        {
            if (isUpdatingTextProgrammatically) return;
            if (RdoRange != null && RdoRange.IsChecked != true)
            {
                RdoRange.IsChecked = true;
            }
        }

        private (int start, int last) ParseRangeNumbers(string startStr, string lastStr, int defaultMin, int defaultMax)
        {
            int start = defaultMin > 0 ? defaultMin : 1;
            int last = defaultMax > 0 ? defaultMax : 99999;

            string combined = $"{startStr} {lastStr}".Trim();
            var matches = Regex.Matches(combined, @"\d+");
            if (matches.Count >= 2)
            {
                if (int.TryParse(matches[0].Value, out int s) && s > 0) start = s;
                if (int.TryParse(matches[1].Value, out int l) && l > 0) last = l;
            }
            else if (matches.Count == 1)
            {
                if (int.TryParse(matches[0].Value, out int num) && num > 0)
                {
                    if (Regex.IsMatch(startStr, @"\d+"))
                    {
                        start = num;
                        last = defaultMax;
                    }
                    else
                    {
                        start = defaultMin;
                        last = num;
                    }
                }
            }

            if (start > last)
            {
                (start, last) = (last, start);
            }

            return (start, last);
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

            // 사용자가 '일부 범위(RdoRange)'를 체크하고 이미 입력해둔 상태라면 덮어쓰지 않고 보존
            if (RdoRange.IsChecked != true)
            {
                isUpdatingTextProgrammatically = true;
                TxtStart.Text = meta.MinNum.ToString();
                TxtLast.Text = meta.MaxNum.ToString();
                isUpdatingTextProgrammatically = false;
            }
            else
            {
                isUpdatingTextProgrammatically = true;
                if (string.IsNullOrWhiteSpace(TxtStart.Text)) TxtStart.Text = meta.MinNum.ToString();
                if (string.IsNullOrWhiteSpace(TxtLast.Text)) TxtLast.Text = meta.MaxNum.ToString();
                isUpdatingTextProgrammatically = false;
            }

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

        private async Task<bool> AddToQueueAsync()
        {
            string url = TxtUrl.Text.Trim();
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("소설 URL을 입력해주세요.", "알림", MessageBoxButton.OK, MessageBoxImage.Warning);
                return false;
            }

            // 사용자가 '일부 범위' 모드에서 입력한 시작/끝 값을 미리 캡처해 둠 (메타 조회 시 덮어쓰기 방지)
            bool isRangeMode = RdoRange.IsChecked == true;
            string customStartText = TxtStart.Text.Trim();
            string customLastText = TxtLast.Text.Trim();

            BtnAddToQueue.IsEnabled = false;
            BtnAddToQueue.Content = "추가 중...";

            NovelMetaInfo? meta = null;
            try
            {
                meta = await FetchNovelMetaAsync(url);
                if (meta != null)
                {
                    UpdateNovelInfoCard(meta);
                }
            }
            catch (Exception ex)
            {
                AppendLog($"[경고] 메타 정보 조회 실패, 기본값 사용: {ex.Message}");
            }
            finally
            {
                BtnAddToQueue.IsEnabled = true;
                BtnAddToQueue.Content = "➕ 대기열에 추가";
            }

            int defaultMin = meta != null ? meta.MinNum : 1;
            int defaultMax = meta != null ? meta.MaxNum : 99999;
            int start;
            int last;
            string rangeText;

            if (isRangeMode)
            {
                // 스마트 범위 파싱: '971 , 1066', '971-1066', '971화', 쉼표/하이픈 등 모든 형식 완벽 지원
                (start, last) = ParseRangeNumbers(customStartText, customLastText, defaultMin, defaultMax);

                rangeText = $"{start}화~{last}화";

                // UI 텍스트도 보정된 깔끔한 숫자 값으로 업데이트
                isUpdatingTextProgrammatically = true;
                TxtStart.Text = start.ToString();
                TxtLast.Text = last.ToString();
                isUpdatingTextProgrammatically = false;
            }
            else
            {
                start = defaultMin;
                last = defaultMax;
                rangeText = meta != null && meta.IsCompleted ? $"{start}~{last}화 [완결]" : $"전체 ({start}~{last}화)";
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
            SaveQueueToFile();
            AppendLog($"➕ 대기열에 추가됨: {finalTitle} ({rangeText})");
            return true;
        }

        private async void BtnAddToQueue_Click(object sender, RoutedEventArgs e)
        {
            await AddToQueueAsync();
        }

        private void BtnRemoveSelected_Click(object sender, RoutedEventArgs e)
        {
            if (LstQueue.SelectedItem is DownloadItem selected)
            {
                queueList.Remove(selected);
                ReindexQueue();
                SaveQueueToFile();
            }
        }

        private void BtnClearQueue_Click(object sender, RoutedEventArgs e)
        {
            queueList.Clear();
            SaveQueueToFile();
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
                bool added = await AddToQueueAsync();
                if (!added || queueList.Count == 0) return;
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
                            item.ProgressValue = 100;
                            item.StatusText = "완료 (100%)";
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
            Dispatcher.Invoke(() =>
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
                    item.ProgressValue = percent;
                    item.StatusText = $"{percent}% ({current}/{total}화)";
                    item.StatusBg = new SolidColorBrush(Color.FromRgb(168, 85, 247)); // 퍼플
                }

                if (line.Contains("통합 텍스트 파일 생성 완료:"))
                {
                    LblCurrentTask.Text = line;
                }
            });
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
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => AppendLog(msg));
                return;
            }

            string timeStr = DateTime.Now.ToString("HH:mm:ss");
            TxtConsoleLog.AppendText($"\n[{timeStr}] {msg}");
            LogScrollViewer.ScrollToEnd();
        }

        private string GetProjectRootDir()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            // 1. 실행 파일과 같은 폴더에 down.js가 있는 경우
            if (File.Exists(Path.Combine(baseDir, "down.js"))) return baseDir;

            // 2. 상위 1~4단계 디렉토리 순차 탐색
            string candidate = baseDir;
            for (int i = 0; i < 4; i++)
            {
                candidate = Path.GetFullPath(Path.Combine(candidate, ".."));
                if (File.Exists(Path.Combine(candidate, "down.js"))) return candidate;
            }

            // 3. 작업 디렉토리
            string currentDir = Directory.GetCurrentDirectory();
            if (File.Exists(Path.Combine(currentDir, "down.js"))) return currentDir;

            return baseDir;
        }

        protected override void OnClosed(EventArgs e)
        {
            abortRequested = true;
            SaveQueueToFile();
            RestoreSystemSleep();
            if (runningProcess != null && !runningProcess.HasExited)
            {
                try { runningProcess.Kill(true); } catch { }
            }
            base.OnClosed(e);
        }
    }
}