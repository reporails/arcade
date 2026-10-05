# doom-claude: doomgeneric (./doomgeneric, GPL-2.0) with the platform layer in
# doomgeneric_claude.c. No libraries beyond libc and libm (and Winsock and
# winmm on Windows). `make` builds ./doom-claude for this machine; the mod runs
# it when no prebuilt binary under bin/ fits. build-all.sh builds bin/ for
# every platform with zig cc, passing CC, OUT, OBJDIR, LIBS and LDFLAGS.

CC ?= cc
CFLAGS += -O2 -w -DNORMALUNIX -DLINUX -D_DEFAULT_SOURCE -Idoomgeneric
LIBS ?= -lm
LDFLAGS ?=
ifeq ($(OS),Windows_NT)
LIBS += -lws2_32 -lwinmm
OUT ?= doom-claude.exe
endif
OUT ?= doom-claude

SRC_DOOM = dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info i_cdmus i_endoom i_joystick i_scale i_sound i_system i_timer memio m_argv m_bbox m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main w_wad z_zone w_file_stdc i_input i_video doomgeneric

OBJDIR ?= build
OBJS = $(addprefix $(OBJDIR)/, $(addsuffix .o, $(SRC_DOOM))) $(OBJDIR)/doomgeneric_claude.o

$(OUT): $(OBJS)
	mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(LDFLAGS) $(OBJS) -o $@ $(LIBS)

$(OBJDIR):
	mkdir -p $(OBJDIR)

$(OBJDIR)/doomgeneric_claude.o: doomgeneric_claude.c | $(OBJDIR)
	$(CC) $(CFLAGS) -Wall -c $< -o $@

$(OBJDIR)/%.o: doomgeneric/%.c | $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -rf build doom-claude doom-claude.exe

.PHONY: clean
