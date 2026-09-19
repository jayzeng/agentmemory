class AgentMemory < Formula
  desc "agentmemory CLI: persistent memory for coding agents with qmd semantic search"
  homepage "https://github.com/jayzeng/agentmemory"
  url "https://github.com/jayzeng/agentmemory/archive/refs/tags/v0.6.0.tar.gz"
  sha256 "602fa01c7336bbfa222508877bb49391c69e330f64192ae428e8d836aa1f278a"
  version "0.6.0"
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
