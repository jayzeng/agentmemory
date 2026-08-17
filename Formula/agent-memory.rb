class AgentMemory < Formula
  desc "agentmemory CLI: persistent memory for coding agents with qmd semantic search"
  homepage "https://github.com/jayzeng/agentmemory"
  url "https://github.com/jayzeng/agentmemory/archive/refs/tags/v0.4.16.tar.gz"
  sha256 "c871a4792c02e4468a5387c3aeb22a529ed542a52dcc18095b6c6ade48be8b8d"
  version "0.4.16"
  license "MIT"

  depends_on "bun" => :build

  def install
    system "bun", "build", "src/cli.ts",
      "--compile",
      "--outfile", "agent-memory",
      "--define", "__VERSION__=\"'#{version}'\""

    libexec.install "skills"
    libexec_bin = libexec/"bin"
    libexec_bin.install "agent-memory"
    bin.env_script_all_files(libexec_bin, AGENT_MEMORY_SKILLS_ROOT: libexec)
  end

  test do
    system "#{bin}/agent-memory", "status"
  end
end
