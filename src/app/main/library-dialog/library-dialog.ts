import { DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import {
  faCheck,
  faExclamationTriangle,
  faFloppyDisk,
  faFolder,
  faLayerGroup,
  faPencil,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import { Base } from '~/base/base';
import { Button } from '~/components/button/button';
import { Confirm } from '~/components/confirm/confirm';
import { DialogData } from '~/components/dialog/dialog';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Library, LibraryBuild, LibraryFolder } from '~/library/library';
import { TranslatePipe } from '~/translate/translate-pipe';

@Component({
  selector: 'lab-library-dialog',
  imports: [FormsModule, FaIconComponent, Button, Tooltip, TranslatePipe],
  templateUrl: './library-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex w-2xl max-w-full flex-col gap-3 overflow-hidden p-3 pt-0 sm:gap-4 sm:p-6 sm:pt-0',
  },
})
export class LibraryDialog implements DialogData {
  protected readonly dialogRef = inject(DialogRef);
  private readonly confirm = inject(Confirm);
  protected readonly library = inject(Library);
  protected readonly base = inject(Base);

  readonly header = 'library.header';

  readonly saveName = signal(this.library.current() ?? '');
  readonly saveFolder = signal(
    this.library.builds().find((b) => b.name === this.library.current())?.meta
      .folder ?? '',
  );
  readonly search = signal('');

  /** Name of the build being edited */
  readonly editing = signal<string | null>(null);
  readonly editName = signal('');
  readonly editFolder = signal('');
  readonly editTags = signal('');
  readonly editNotes = signal('');

  readonly filtered = computed((): LibraryFolder[] => {
    const terms = this.search().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.library.folders();

    const matches = (b: LibraryBuild): boolean => {
      const text = [b.name, b.meta.folder, b.meta.notes, ...(b.meta.tags ?? [])]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => text.includes(t));
    };

    return this.library
      .folders()
      .map((f) => ({ folder: f.folder, builds: f.builds.filter(matches) }))
      .filter((f) => f.builds.length);
  });

  protected readonly faCheck = faCheck;
  protected readonly faFloppyDisk = faFloppyDisk;
  protected readonly faFolder = faFolder;
  protected readonly faLayerGroup = faLayerGroup;
  protected readonly faPencil = faPencil;
  protected readonly faTrash = faTrash;
  protected readonly faXmark = faXmark;

  save(): void {
    const name = this.saveName().trim();
    if (!name) return;
    this.library.saveCurrent(name, this.saveFolder().trim());
  }

  async open(build: LibraryBuild): Promise<void> {
    await this.library.open(build.name);
    this.dialogRef.close();
  }

  edit(build: LibraryBuild): void {
    this.editing.set(build.name);
    this.editName.set(build.name);
    this.editFolder.set(build.meta.folder ?? '');
    this.editTags.set((build.meta.tags ?? []).join(', '));
    this.editNotes.set(build.meta.notes ?? '');
  }

  saveEdit(): void {
    const from = this.editing();
    const name = this.editName().trim();
    if (from == null || !name) return;

    const tags = this.editTags()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    this.library.update(from, name, {
      folder: this.editFolder().trim() || undefined,
      tags: tags.length ? tags : undefined,
      notes: this.editNotes().trim() || undefined,
    });
    this.editing.set(null);
  }

  remove(build: LibraryBuild): void {
    this.confirm
      .open({
        header: 'library.deleteHeader',
        message: 'library.deleteMessage',
        icon: faExclamationTriangle,
        actions: [
          { text: 'delete', value: true, icon: faTrash },
          { text: 'cancel', value: false, icon: faXmark },
        ],
      })
      .subscribe((res) => {
        if (res) this.library.remove(build.name);
      });
  }

  /** Makes a base with one tab per build in a folder, named after it */
  async makeBase(group: LibraryFolder): Promise<void> {
    const name = group.folder || 'Base';
    if (!this.base.names().includes(name))
      this.base.create(
        name,
        group.builds.map((b) => b.name),
      );
    this.dialogRef.close();
    await this.base.open(name);
  }

  async openBase(name: string): Promise<void> {
    this.dialogRef.close();
    await this.base.open(name);
  }

  removeBase(name: string): void {
    this.confirm
      .open({
        header: 'base.deleteHeader',
        message: 'base.deleteMessage',
        icon: faExclamationTriangle,
        actions: [
          { text: 'delete', value: true, icon: faTrash },
          { text: 'cancel', value: false, icon: faXmark },
        ],
      })
      .subscribe((res) => {
        if (res) this.base.remove(name);
      });
  }

  updated(build: LibraryBuild): string {
    const at = build.meta.updatedAt;
    return at ? new Date(at).toLocaleDateString() : '';
  }
}
