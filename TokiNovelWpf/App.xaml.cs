using System;
using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace TokiNovelWpf
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            this.DispatcherUnhandledException += App_DispatcherUnhandledException;
            AppDomain.CurrentDomain.UnhandledException += CurrentDomain_UnhandledException;
            TaskScheduler.UnobservedTaskException += TaskScheduler_UnobservedTaskException;
        }

        private void App_DispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
        {
            LogCrash("DispatcherUnhandledException", e.Exception);
            MessageBox.Show($"오류가 발생했습니다:\n{e.Exception.Message}\n\n프로그램을 계속 실행합니다.", "오류 알림", MessageBoxButton.OK, MessageBoxImage.Warning);
            e.Handled = true; // 강제 종료 방지
        }

        private void CurrentDomain_UnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            if (e.ExceptionObject is Exception ex)
            {
                LogCrash("CurrentDomain_UnhandledException", ex);
            }
        }

        private void TaskScheduler_UnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
        {
            LogCrash("UnobservedTaskException", e.Exception);
            e.SetObserved(); // 강제 종료 방지
        }

        private void LogCrash(string type, Exception ex)
        {
            try
            {
                string log = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{type}]\n{ex}\n\n";
                File.AppendAllText("error_crash.log", log);
            }
            catch { }
        }
    }
}
