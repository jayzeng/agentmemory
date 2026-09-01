class AgentMemory < Formula
  desc "agentmemory CLI: persistent memory for coding agents with qmd semantic search"
  homepage "https://github.com/jayzeng/agentmemory"
  url "https://github.com/jayzeng/agentmemory/archive/refs/tags/v0.5.0.tar.gz"
  sha256 "2de2a5a2f650b81514cd70d823346fbbb40a92f2261c734b289040e9821f9f13"
  version "0.5.0"
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
