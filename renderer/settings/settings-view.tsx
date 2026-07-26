import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  toast,
} from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import type { NativeThemeInfo } from "@glaze/core/ipc";
import { FolderOpen } from "lucide-react";

interface DocumentRecord {
  id: number;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
}

const TYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  xlsx: "Spreadsheet",
  csv: "CSV",
  txt: "Text",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function SettingsView() {
  useTheme();

  // Close the window on Escape (unless typing in a control).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const vaultPathQuery = useQuery({
    queryKey: ["vaultPath"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<string>("vault:getVaultPath"),
  });

  const statsQuery = useQuery({
    queryKey: ["vaultStats"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<{ total: number; converted: number }>("vault:getStats"),
  });

  const documentsQuery = useQuery({
    queryKey: ["vaultDocuments"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<DocumentRecord[]>("vault:listDocuments"),
  });

  const themeQuery = useQuery({
    queryKey: ["themeInfo"],
    queryFn: () => window.glazeAPI.nativeTheme.getInfo(),
  });

  const handleThemeChange = async (value: string) => {
    try {
      await window.glazeAPI.nativeTheme.setThemeSource(value as NativeThemeInfo["themeSource"]);
      themeQuery.refetch();
    } catch (error) {
      toast.error(`Failed to set theme: ${error}`);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await window.glazeAPI.glaze.ipc.invoke("vault:openFolder");
    } catch (error) {
      toast.error(`Failed to open vault: ${error}`);
    }
  };

  const documents = documentsQuery.data ?? [];
  const stats = statsQuery.data;

  return (
    <ScrollArea
      toolbar={
        <Toolbar>
          <ToolbarContent>
            <ToolbarTitle>Quick2Afvault</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      }
    >
      <div className="px-5 pb-10 flex flex-col gap-8">
        {/* Vault location */}
        <section className="flex flex-col gap-3">
          <Text variant="strong">Vault</Text>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col min-w-0">
              <Text variant="small" color="secondary" className="truncate">
                {vaultPathQuery.data ?? "…"}
              </Text>
              {stats ? (
                <Text variant="small" color="tertiary" className="tabular-nums">
                  {stats.total} document{stats.total === 1 ? "" : "s"} · {stats.converted} converted
                </Text>
              ) : null}
            </div>
            <Button variant="accent" onClick={handleOpenFolder} className="shrink-0">
              <FolderOpen className="size-4" />
              Open Vault Folder
            </Button>
          </div>
        </section>

        <Separator />

        {/* Ingested documents */}
        <section className="flex flex-col gap-3">
          <Text variant="strong">Documents</Text>
          {documents.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>No documents yet</EmptyStateTitle>
              <EmptyStateDescription>Drag files onto the orb to add them to your vault.</EmptyStateDescription>
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Markdown</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => (
                  <TableRow key={doc.id}>
                    <TableCell className="max-w-[220px] truncate" title={doc.originalFilename}>
                      {doc.originalFilename}
                    </TableCell>
                    <TableCell>
                      <Text variant="small" color="secondary">
                        {TYPE_LABEL[doc.fileType] ?? doc.fileType}
                      </Text>
                    </TableCell>
                    <TableCell>
                      <Text variant="small" color="secondary" className="tabular-nums">
                        {formatDate(doc.dateIngested)}
                      </Text>
                    </TableCell>
                    <TableCell>
                      <Text variant="small" color={doc.markdownSuccess ? "green" : "tertiary"}>
                        {doc.markdownSuccess ? "Converted" : "Not converted"}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <Separator />

        {/* Appearance */}
        <section className="flex items-center justify-between gap-4">
          <Text variant="strong">Appearance</Text>
          <RadioGroup
            value={themeQuery.data?.themeSource ?? "system"}
            onValueChange={handleThemeChange}
            orientation="horizontal"
          >
            <Label>
              <RadioGroupItem value="system" />
              Auto
            </Label>
            <Label>
              <RadioGroupItem value="light" />
              Light
            </Label>
            <Label>
              <RadioGroupItem value="dark" />
              Dark
            </Label>
          </RadioGroup>
        </section>
      </div>
    </ScrollArea>
  );
}
