using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

static class Shim
{
    const string RealBinEnv = "CLAUDE_REAL_BIN";
    const string MarkerDirEnv = "CLAUDE_RELAUNCH_DIR";

    // Boite ends a thread by ending the process it started, which is now the
    // wrapper. Claude Code would be left running with nobody reading its
    // terminal, so it goes in a job the system closes with the wrapper.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    const int ExtendedLimitInformation = 9;
    const uint KillOnJobClose = 0x2000;

    static IntPtr MakeKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION starts with the basic structure,
        // whose two 64-bit time limits put LimitFlags at offset 16 on either
        // architecture; only the total size differs.
        int size = IntPtr.Size == 8 ? 144 : 112;
        IntPtr info = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(info, i, 0);
            Marshal.WriteInt32(info, 16, unchecked((int)KillOnJobClose));
            if (!SetInformationJobObject(job, ExtendedLimitInformation, info, (uint)size)) return IntPtr.Zero;
        }
        finally { Marshal.FreeHGlobal(info); }
        return job;
    }

    static string MarkerDir()
    {
        string dir = Environment.GetEnvironmentVariable(MarkerDirEnv);
        if (string.IsNullOrEmpty(dir))
        {
            dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "claude-cc-relaunch");
        }
        return dir;
    }

    static string StoreDir()
    {
        string home = Environment.GetEnvironmentVariable("USERPROFILE");
        if (string.IsNullOrEmpty(home)) return null;
        return Path.Combine(home, ".claude-cc-accounts");
    }

    // Refusing in silence would look exactly like a thread that simply died, so
    // every refusal lands in the same log the switcher's watchdog writes to.
    static void Note(string message)
    {
        string store = StoreDir();
        if (store == null) return;
        try
        {
            File.AppendAllText(Path.Combine(store, "relaunch.log"),
                DateTime.Now.ToString("s") + " wrapper: " + message + Environment.NewLine);
        }
        catch { }
    }

    // The real binary, resolved without going through PATH again - PATH now
    // points here, so trusting it would make the wrapper call itself. The
    // pinned path is written at install time: scanning PATH picks whatever
    // claude.exe someone put on it, and the wrapper runs that with the
    // arguments of every thread.
    static string RealBin()
    {
        string real = Environment.GetEnvironmentVariable(RealBinEnv);
        if (!string.IsNullOrEmpty(real) && File.Exists(real)) return real;

        string self = Process.GetCurrentProcess().MainModule.FileName;
        string selfDir = Path.GetDirectoryName(self);
        if (!string.IsNullOrEmpty(selfDir))
        {
            string pinFile = Path.Combine(selfDir, "real-bin.txt");
            if (File.Exists(pinFile))
            {
                string pinned = null;
                try { pinned = File.ReadAllText(pinFile).Trim(); } catch { }
                if (!string.IsNullOrEmpty(pinned) && File.Exists(pinned)) return pinned;
            }
        }

        string home = Environment.GetEnvironmentVariable("USERPROFILE");
        if (!string.IsNullOrEmpty(home))
        {
            string guess = Path.Combine(home, @".local\bin\claude.exe");
            if (File.Exists(guess)) return guess;
        }

        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string part in path.Split(';'))
        {
            if (part.Length == 0) continue;
            string candidate;
            try { candidate = Path.Combine(part.Trim('"'), "claude.exe"); }
            catch { continue; }
            if (File.Exists(candidate) &&
                !string.Equals(Path.GetFullPath(candidate), Path.GetFullPath(self),
                               StringComparison.OrdinalIgnoreCase))
                return candidate;
        }
        return null;
    }

    // The HMAC key of the account pool, encrypted with DPAPI for this Windows
    // user. Missing means the switcher was never run here, and markers are then
    // taken as they were before signing existed; unreadable means the key
    // belongs to somebody else, and nothing can be trusted.
    enum KeyState { Missing, Unusable, Ok }

    static byte[] PoolKey(out KeyState state)
    {
        state = KeyState.Missing;
        string store = StoreDir();
        if (store == null) return null;
        string keyFile = Path.Combine(store, ".pool.key");
        if (!File.Exists(keyFile)) return null;
        try
        {
            byte[] key = ProtectedData.Unprotect(File.ReadAllBytes(keyFile), null, DataProtectionScope.CurrentUser);
            state = KeyState.Ok;
            return key;
        }
        catch { state = KeyState.Unusable; return null; }
    }

    static string Hmac(byte[] key, string content)
    {
        using (var h = new HMACSHA256(key))
        {
            byte[] mac = h.ComputeHash(Encoding.UTF8.GetBytes(content));
            var sb = new StringBuilder(mac.Length * 2);
            foreach (byte b in mac) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    // Constant-time on purpose: the comparison is against a value the other side
    // chose, and an early exit leaks how much of a guess was right.
    static bool SameSignature(string a, string b)
    {
        if (a == null || b == null || a.Length != b.Length) return false;
        int diff = 0;
        for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    // The marker holds a command line this wrapper is about to run, so it is as
    // powerful as a `claude` invocation - `--mcp-config` alone is arbitrary
    // code. Anything that can write into the marker folder could otherwise
    // choose what this terminal comes back as.
    static bool MarkerTrusted(string marker, string content)
    {
        KeyState state;
        byte[] key = PoolKey(out state);
        if (state == KeyState.Missing)
        {
            // No key at all means the switcher has never run here, and markers
            // are taken as they were before signing existed. But a pool that
            // exists with its key removed is the interesting case: deleting one
            // file would otherwise be enough to get an unsigned command line
            // accepted.
            string store = StoreDir();
            if (store != null && File.Exists(Path.Combine(store, ".pool.json")))
            {
                Note("refused a marker: the pool exists but .pool.key is gone");
                return false;
            }
            return true;
        }
        if (state == KeyState.Unusable)
        {
            Note("refused a marker: the pool key cannot be read by this user");
            return false;
        }
        string sigFile = marker + ".sig";
        if (!File.Exists(sigFile))
        {
            Note("refused an unsigned marker: " + marker);
            return false;
        }
        string sig = null;
        try { sig = File.ReadAllText(sigFile).Trim().ToLowerInvariant(); } catch { }
        if (!SameSignature(sig, Hmac(key, content)))
        {
            Note("refused a marker whose signature does not match: " + marker);
            return false;
        }
        return true;
    }

    // The arguments exactly as they were typed. Rebuilding them from argv would
    // lose the quoting of things like `-- "a prompt with spaces"`.
    static string RawArguments()
    {
        string line = Environment.CommandLine;
        int i = 0;
        if (i < line.Length && line[i] == '"')
        {
            i++;
            while (i < line.Length && line[i] != '"') i++;
            if (i < line.Length) i++;
        }
        else
        {
            while (i < line.Length && !char.IsWhiteSpace(line[i])) i++;
        }
        return line.Substring(Math.Min(i, line.Length)).TrimStart();
    }

    static int Main()
    {
        string real = RealBin();
        if (real == null)
        {
            Console.Error.WriteLine("claude: the real binary was not found (set " + RealBinEnv + ").");
            return 127;
        }

        // Ctrl+C belongs to the child: the wrapper stays up to hand the terminal
        // back, or to start the child again.
        Console.CancelKeyPress += delegate (object s, ConsoleCancelEventArgs e) { e.Cancel = true; };

        string args = RawArguments();
        string dir = MarkerDir();
        IntPtr job = MakeKillOnCloseJob();

        while (true)
        {
            var psi = new ProcessStartInfo(real, args);
            psi.UseShellExecute = false;
            var child = Process.Start(psi);
            if (job != IntPtr.Zero) AssignProcessToJobObject(job, child.Handle);
            child.WaitForExit();

            string marker = Path.Combine(dir, "relaunch-" + child.Id);
            if (!File.Exists(marker)) return child.ExitCode;

            string next = null;
            try { next = File.ReadAllText(marker).Trim(); } catch { }
            bool trusted = !string.IsNullOrEmpty(next) && MarkerTrusted(marker, next);
            try { File.Delete(marker); } catch { }
            try { File.Delete(marker + ".sig"); } catch { }

            if (!trusted) return child.ExitCode;
            args = next;
        }
    }
}
